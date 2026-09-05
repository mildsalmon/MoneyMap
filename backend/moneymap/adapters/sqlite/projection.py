"""A fixed-query projection read model; callers own one read snapshot."""

import datetime as dt
from itertools import groupby

from moneymap.app_services.scenarios import get_scenario, now
from moneymap.domain.errors import DomainConflictError
from moneymap.domain.projection import ProjectionEvent, ProjectionInputs
from .scenarios import ScenarioWriter
from .rules import ScenarioRuleWriter


class ProjectionInputReader:
    def __init__(self, conn):
        self.conn = conn

    def read(self, sid: int, *, allow_legacy=False) -> ProjectionInputs:
        if not self.conn.in_transaction:
            raise RuntimeError("Projection requires a read snapshot")
        scenario = get_scenario(ScenarioWriter(self.conn), sid)
        if scenario.is_actual:
            scenario = scenario.model_copy(update={"fork_date": now().date()})
        elif scenario.rule_mode == "legacy_snapshot" and not allow_legacy:
            raise DomainConflictError(
                "새 전망을 보기 전에 기존 가정을 분류하세요",
                code="legacy_rule_resolution_required",
            )
        revisions = self.conn.execute(
            "SELECT * FROM calculation_revisions WHERE id=1"
        ).fetchone()
        account_types = tuple(
            (r["id"], r["type"])
            for r in self.conn.execute("SELECT id,type FROM accounts")
        )
        balances = tuple(
            (r["account_id"], r["balance"])
            for r in self.conn.execute(
                "SELECT p.account_id,sum(p.amount) balance FROM transactions t JOIN postings p ON p.txn_id=t.id WHERE t.scenario_id=1 AND t.posted=1 AND t.date<=? GROUP BY p.account_id",
                (scenario.fork_date.isoformat(),),
            )
        )
        rules = ScenarioRuleWriter(self.conn)
        actual = tuple(rules.find_by_scenario(1))
        owned = () if sid == 1 else tuple(rules.find_by_scenario(sid))
        planned = []
        if sid != 1:
            rows = self.conn.execute(
                "SELECT t.id,t.date,t.description,p.account_id,p.amount FROM transactions t JOIN postings p ON p.txn_id=t.id WHERE t.scenario_id=? AND t.posted=1 AND t.source_rule_id IS NULL AND t.date>? ORDER BY t.id,p.id",
                (sid, scenario.fork_date.isoformat()),
            ).fetchall()
            for tid, postings in groupby(rows, key=lambda r: r["id"]):
                postings = list(postings)
                row = postings[0]
                planned.append(
                    ProjectionEvent(
                        dt.date.fromisoformat(row["date"]),
                        "planned_transaction",
                        tid,
                        row["description"],
                        "scenario",
                        tuple((p["account_id"], p["amount"]) for p in postings),
                    )
                )
        return ProjectionInputs(
            scenario,
            revisions["actual_ledger_revision"],
            revisions["actual_rule_revision"],
            account_types,
            balances,
            actual,
            owned,
            tuple(planned),
        )

    def legacy_inputs(self, sid: int, today: dt.date):
        """Only the compatibility dashboard uses the historical fork boundary."""
        from .transactions import SqliteTransactionRepository

        scenario = get_scenario(ScenarioWriter(self.conn), sid)
        account_types = {
            r["id"]: r["type"]
            for r in self.conn.execute("SELECT id,type FROM accounts")
        }
        opening = self.conn.execute(
            "SELECT coalesce(sum(p.amount),0) FROM transactions t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id WHERE t.scenario_id=1 AND t.posted=1 AND a.type IN ('asset','liability') AND (t.date<? OR (t.date=? AND t.source_rule_id IS NULL))",
            (scenario.fork_date.isoformat(), scenario.fork_date.isoformat()),
        ).fetchone()[0]
        txns = SqliteTransactionRepository(self.conn)
        return (
            scenario,
            account_types,
            opening,
            txns.find_by_scenario(1, end=today),
            txns.find_by_scenario(sid, start=scenario.fork_date),
            ScenarioRuleWriter(self.conn).find_by_scenario(sid),
        )

    def actual_history(self, through: str):
        rows = self.conn.execute(
            "SELECT t.date,sum(CASE WHEN a.type IN ('asset','liability') THEN p.amount ELSE 0 END) delta FROM transactions t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id WHERE t.scenario_id=1 AND t.posted=1 AND t.date<=? GROUP BY t.date ORDER BY t.date",
            (through,),
        )
        running = 0
        points = []
        for row in rows:
            running += row["delta"]
            points.append({"date": row["date"], "net_worth": running})
        return points
