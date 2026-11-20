"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import datetime
import sqlite3

from moneymap.domain.errors import DomainNotFoundError
from moneymap.domain.money import Money
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID

from .common import _iso
from .krw_reporting import KRW_TRANSACTION
from .scenarios import ScenarioWriter


class SqliteLedgerQueries:
    """Stored balances: actual through fork close plus owned manual entries after fork.

    Future rule expansion belongs to ProjectionInputReader and the pure fold.
    Historical legacy snapshot semantics are isolated in the compatibility reader.
    """

    # actual 쪽 fork 경계 조건 (위 docstring의 SQL 표현)
    _ACTUAL_BEFORE_FORK = "(t.scenario_id=? AND t.date <= ?)"

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def actual_krw_balances(self, at: datetime.date) -> dict[int, int]:
        # The indexed balances already have the correct scope on KRW-only ledgers.
        mixed = self._conn.execute("""SELECT 1 FROM account_balance_keys k
            JOIN accounts a ON a.id=k.account_id
            WHERE k.currency<>'KRW' OR a.currency<>'KRW' LIMIT 1""").fetchone()
        if not mixed:
            return self.balances_at(at, ACTUAL_SCENARIO_ID)
        rows = self._conn.execute(f"""SELECT p.account_id,p.amount FROM transactions t
            JOIN postings p ON p.txn_id=t.id WHERE t.scenario_id=? AND t.posted=1
            AND t.date<=? AND {KRW_TRANSACTION}""", (ACTUAL_SCENARIO_ID, _iso(at)))
        totals: dict[int, int] = {}
        for aid, amount in rows:
            totals[aid] = totals.get(aid, 0) + amount
        return totals

    def balances_at(self, at: datetime.date, scenario_id: int) -> dict[int, int]:
        return {aid: amounts.get("KRW", 0)
                for aid, amounts in self.balances_by_currency(at, scenario_id).items()}

    def balances_by_currency(self, at: datetime.date, scenario_id: int) -> dict[int, dict[str, int]]:
        if scenario_id == ACTUAL_SCENARIO_ID:
            rows = self._conn.execute("""SELECT k.account_id,k.currency,COALESCE((
              SELECT b.balance FROM account_balance_history b
              WHERE b.account_id=k.account_id AND b.currency=k.currency AND b.date<=?
              ORDER BY b.date DESC,b.txn_id DESC LIMIT 1
            ),0) AS bal FROM account_balance_keys k""", (_iso(at),))
        else:
            scope, params = self._stored_scope(at, scenario_id)
            rows = self._conn.execute(f"""SELECT p.account_id,p.currency,SUM(p.amount) AS bal
              FROM postings p JOIN transactions t ON t.id=p.txn_id
              WHERE t.posted=1 AND ({scope})
              GROUP BY p.account_id,p.currency""", params)
        totals: dict[int, dict[str, int]] = {}
        for row in rows:
            totals.setdefault(row["account_id"], {})[row["currency"]] = row["bal"]
        return totals

    def _stored_scope(self, at, scenario_id):
        repo = ScenarioWriter(self._conn)
        scenario = repo.find_by_id(scenario_id)
        if scenario is None:
            raise DomainNotFoundError("시나리오가 없습니다", code="scenario_not_found", context={"scenario_id": scenario_id})
        lineage = repo.lineage(scenario)
        owners = ",".join("?" for _ in lineage)
        scope = f"""(t.scenario_id=1 AND t.date<=?) OR (
            t.scenario_id IN ({owners}) AND t.source_rule_id IS NULL AND t.date<=?
            AND t.date>(SELECT fork_date FROM scenarios WHERE id=t.scenario_id))"""
        return scope, (_iso(lineage[0].fork_date), *(s.id for s in lineage), _iso(at))

    def balance_at(self, account_id: int, at: datetime.date, scenario_id: int) -> Money:
        row = self._conn.execute("SELECT currency FROM accounts WHERE id=?", (account_id,)).fetchone()
        currency = row["currency"] if row else "KRW"
        balances = self.balances_by_currency(at, scenario_id)
        return Money(amount=balances.get(account_id, {}).get(currency, 0), currency=currency)

    def actual_base_net_worth(self, fork: datetime.date) -> int:
        """시나리오 시뮬레이션의 시작 순자산 — fork 경계의 actual 쪽만.

        fork 당일을 포함한 게시 완료 실제 거래를 합산한다.
        규칙으로 생성한 실제 거래도 시작일 마감 잔액에 포함한다.
        """
        row = self._conn.execute(
            "SELECT COALESCE(SUM(p.amount),0) AS nw FROM postings p"
            " JOIN transactions t ON t.id = p.txn_id"
            " JOIN accounts a ON a.id = p.account_id"
            " WHERE a.type IN ('asset','liability') AND t.posted=1 AND "
            f"  {self._ACTUAL_BEFORE_FORK} AND {KRW_TRANSACTION}",
            (ACTUAL_SCENARIO_ID, _iso(fork)),
        ).fetchone()
        return row["nw"]

    def net_worth_at(self, at: datetime.date, scenario_id: int) -> int:
        """순자산 = 자산·부채 계정 posting의 합 (fold 의미론은 balance_at과 동일)."""
        nw_filter = f"a.type IN ('asset','liability') AND {KRW_TRANSACTION}"
        if scenario_id == ACTUAL_SCENARIO_ID:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(p.amount),0) AS nw FROM postings p"
                " JOIN transactions t ON t.id = p.txn_id"
                " JOIN accounts a ON a.id = p.account_id"
                f" WHERE {nw_filter} AND t.scenario_id=? AND t.posted=1 AND t.date<=?",
                (ACTUAL_SCENARIO_ID, _iso(at)),
            ).fetchone()
            return row["nw"]

        scope, params = self._stored_scope(at, scenario_id)
        row = self._conn.execute(
            "SELECT COALESCE(SUM(p.amount),0) AS nw FROM postings p"
            " JOIN transactions t ON t.id = p.txn_id"
            " JOIN accounts a ON a.id = p.account_id"
            f" WHERE {nw_filter} AND t.posted=1 AND ({scope})",
            params,
        ).fetchone()
        return row["nw"]

    def status(self) -> tuple[int, str | None]:
        total = self._conn.execute(
            "SELECT COALESCE(SUM(p.amount),0) AS s FROM postings p"
            " JOIN transactions t ON t.id=p.txn_id WHERE t.posted=1"
        ).fetchone()["s"]
        last_entry = self._conn.execute(
            "SELECT MAX(date) AS d FROM transactions WHERE posted=1 AND scenario_id=?",
            (ACTUAL_SCENARIO_ID,),
        ).fetchone()["d"]
        return total, last_entry
