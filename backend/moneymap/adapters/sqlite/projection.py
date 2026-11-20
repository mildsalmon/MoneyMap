"""A fixed-query projection read model; callers own one read snapshot."""

import datetime as dt
from dataclasses import replace
from itertools import groupby

from moneymap.app_services.scenarios import get_scenario, now
from moneymap.domain.errors import DomainConflictError
from moneymap.domain.projection import ProjectionEvent, ProjectionInputs, expand_events
from moneymap.domain.money import Money
from moneymap.domain.transaction import Posting, Transaction
from .scenarios import ScenarioWriter
from .reporting import SqliteLedgerQueries
from .rules import ScenarioRuleWriter
from .krw_reporting import KRW_TRANSACTION


class ProjectionInputReader:
    """Read whole KRW transactions and rules before folding minor units into won."""

    def __init__(self, conn):
        self.conn = conn

    def read(self, sid: int, *, allow_legacy=False) -> ProjectionInputs:
        if not self.conn.in_transaction:
            raise RuntimeError("Projection requires a read snapshot")
        repo = ScenarioWriter(self.conn)
        scenario = get_scenario(repo, sid)
        lineage = repo.lineage(scenario)
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
        fork = lineage[0].fork_date if lineage else scenario.fork_date
        balances = SqliteLedgerQueries(self.conn).actual_krw_balances(fork)
        rules = ScenarioRuleWriter(self.conn)
        actual = tuple(rules.find_by_scenario(1, krw_only=True))
        forks = {node.id: node.fork_date for node in lineage}
        owned = rules.find_by_scenarios(list(forks), krw_only=True)
        if len(lineage) > 1:
            # A historical opening spans several forks. Clip once here so rule
            # expansion and installment bill capacity share the owner's dates.
            eligible = []
            for rule in owned:
                first = max(rule.start_date, forks[rule.scenario_id] + dt.timedelta(days=1))
                if rule.end_date is None or first <= rule.end_date:
                    eligible.append(rule.model_copy(update={"start_date": first}))
            owned = eligible
        planned = self._planned_events(forks, sid)
        from .installments import projection_inputs

        installment_events, installment_warnings = projection_inputs(
            self.conn, fork, actual, owned, ancestor_rules=[r for r in owned if r.scenario_id != sid]
        )
        inputs = ProjectionInputs(
            scenario,
            revisions["actual_ledger_revision"],
            revisions["actual_rule_revision"],
            account_types,
            tuple(balances.items()),
            actual,
            tuple(owned),
            tuple(planned),
            cash_ids,
            revisions["cash_config_revision"],
            installment_events,
            installment_warnings,
            revisions["installment_revision"],
            tuple((node.id, node.version) for node in lineage[:-1]),
        )
        if fork == scenario.fork_date:
            return inputs
        # The actual ledger stops at the first fork. Carry only projected postings
        # through the child's closing day, including an installment's scenario offset.
        for event in expand_events(inputs, fork + dt.timedelta(days=1), scenario.fork_date):
            postings = event.scenario_postings if event.scenario_postings is not None else event.postings
            for aid, amount in postings:
                balances[aid] = balances.get(aid, 0) + amount
        return replace(inputs, start_balances=tuple(balances.items()))

    def _planned_events(self, forks, sid):
        if not forks:
            return ()
        placeholders = ",".join("?" for _ in forks)
        rows = self.conn.execute(
            f"""SELECT t.id,t.scenario_id,t.date,t.description,p.account_id,p.amount
                FROM transactions t JOIN postings p ON p.txn_id=t.id
                JOIN scenarios s ON s.id=t.scenario_id
                WHERE t.scenario_id IN ({placeholders}) AND t.posted=1
                AND t.source_rule_id IS NULL AND t.date>s.fork_date
                AND {KRW_TRANSACTION} ORDER BY t.id,p.id""",
            tuple(forks),
        )
        events = []
        for tid, items in groupby(rows, key=lambda row: row["id"]):
            postings = list(items)
            row = postings[0]
            events.append(ProjectionEvent(
                dt.date.fromisoformat(row["date"]), "planned_transaction", tid,
                row["description"], "scenario" if row["scenario_id"] == sid else "ancestor",
                tuple((p["account_id"], p["amount"]) for p in postings),
            ))
        return tuple(events)

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
            + f" AND {KRW_TRANSACTION}"
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
        purchases = {r[0] for r in self.conn.execute("SELECT purchase_id FROM installment_plans WHERE exclude_from_spend=1")}
        return account_types, [t for t in self._legacy_transactions(1, end=today) if t.id not in purchases]

    def legacy_inputs(self, sid: int):
        """Only the compatibility dashboard uses the historical fork boundary."""
        scenario = get_scenario(ScenarioWriter(self.conn), sid)
        opening = self.conn.execute(
            "SELECT coalesce(sum(p.amount),0) FROM transactions t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id WHERE t.scenario_id=1 AND t.posted=1 AND a.type IN ('asset','liability') AND (t.date<? OR (t.date=? AND t.source_rule_id IS NULL))"
            f" AND {KRW_TRANSACTION}",
            (scenario.fork_date.isoformat(), scenario.fork_date.isoformat()),
        ).fetchone()[0]
        return (
            scenario,
            opening,
            self._legacy_transactions(sid, start=scenario.fork_date),
            ScenarioRuleWriter(self.conn).find_by_scenario(sid, krw_only=True),
        )

    def actual_history(self, through: str):
        rows = self.conn.execute(
            "SELECT t.date,sum(CASE WHEN a.type IN ('asset','liability') THEN p.amount ELSE 0 END) delta FROM transactions t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id WHERE t.scenario_id=1 AND t.posted=1 AND t.date<=?"
            f" AND {KRW_TRANSACTION} GROUP BY t.date ORDER BY t.date",
            (through,),
        )
        running = 0
        points = []
        for row in rows:
            running += row["delta"]
            points.append({"date": row["date"], "net_worth": running})
        # A quiet day still has the last recorded balance. End the actual curve
        # at the requested cutoff, without inventing a transaction or future value.
        if points and points[-1]["date"] < through:
            points.append({"date": through, "net_worth": running})
        return points
