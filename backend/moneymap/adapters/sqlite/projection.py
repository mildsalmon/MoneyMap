"""A fixed-query projection read model; callers own one read snapshot."""

import datetime as dt
from itertools import groupby

from moneymap.app_services.scenarios import get_scenario, now
from moneymap.domain.errors import DomainConflictError
from moneymap.domain.projection import ProjectionEvent, ProjectionInputs
from moneymap.domain.money import Money
from moneymap.domain.transaction import Posting, Transaction
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
        accounts = self.conn.execute(
            "SELECT id,type,include_in_cash FROM accounts"
        ).fetchall()
        account_types = tuple((r["id"], r["type"]) for r in accounts)
        cash_ids = tuple(r["id"] for r in accounts if r["include_in_cash"])
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
            cash_ids,
            revisions["cash_config_revision"],
        )

    def _legacy_transactions(self, sid: int, *, start=None, end=None):
        """Hydrate legacy transactions and their ordered postings in one query."""
        clauses = ["t.scenario_id=?", "t.posted=1"]
        params = [sid]
        if start is not None:
            clauses.append("t.date>=?")
            params.append(start.isoformat())
        if end is not None:
            clauses.append("t.date<=?")
            params.append(end.isoformat())
        rows = self.conn.execute(
            "SELECT t.id,t.scenario_id,t.date,t.description,t.source_rule_id,"
            "p.account_id,p.amount,p.currency FROM transactions t "
            "JOIN postings p ON p.txn_id=t.id WHERE "
            + " AND ".join(clauses)
            + " ORDER BY t.date,t.id,p.id",
            params,
        )
        transactions = []
        for tid, items in groupby(rows, key=lambda row: row["id"]):
            items = list(items)
            row = items[0]
            transactions.append(
                Transaction(
                    id=tid,
                    scenario_id=row["scenario_id"],
                    date=dt.date.fromisoformat(row["date"]),
                    description=row["description"],
                    source_rule_id=row["source_rule_id"],
                    postings=[
                        Posting(
                            account_id=p["account_id"],
                            amount=Money(amount=p["amount"], currency=p["currency"]),
                        )
                        for p in items
                    ],
                )
            )
        return transactions

    def legacy_actual_inputs(self, today: dt.date):
        """The dashboard shares this actual-ledger input across legacy scenarios."""
        account_types = {
            r["id"]: r["type"]
            for r in self.conn.execute("SELECT id,type FROM accounts")
        }
        return account_types, self._legacy_transactions(1, end=today)

    def legacy_inputs(self, sid: int):
        """Only the compatibility dashboard uses the historical fork boundary."""
        scenario = get_scenario(ScenarioWriter(self.conn), sid)
        opening = self.conn.execute(
            "SELECT coalesce(sum(p.amount),0) FROM transactions t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id WHERE t.scenario_id=1 AND t.posted=1 AND a.type IN ('asset','liability') AND (t.date<? OR (t.date=? AND t.source_rule_id IS NULL))",
            (scenario.fork_date.isoformat(), scenario.fork_date.isoformat()),
        ).fetchone()[0]
        return (
            scenario,
            opening,
            self._legacy_transactions(sid, start=scenario.fork_date),
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
