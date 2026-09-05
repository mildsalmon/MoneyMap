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


class SqliteLedgerQueries:
    """읽기 전용 집계. 시나리오 fold 의미론 (depth-1, D2):

        actual:    date ≤ T 의 actual 거래 합
        시나리오 X: actual 거래 중 [date < fork] 또는
                     [date = fork 이고 수동 입력(source_rule_id IS NULL)]
                  + (X 거래, fork_date ≤ date ≤ T)

    fork 당일 규칙 생성분만 제외하는 이유: 시뮬레이션이 복사된 규칙을
    fork 당일부터 전개하므로, 포함하면 그날 실행분이 이중 계상된다.
    수동 입력(오늘 적은 개시잔액·지출)은 시나리오에도 보여야 한다.
    """

    # actual 쪽 fork 경계 조건 (위 docstring의 SQL 표현)
    _ACTUAL_BEFORE_FORK = "(t.scenario_id=? AND (t.date < ? OR (t.date = ? AND t.source_rule_id IS NULL)))"

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def balance_at(self, account_id: int, at: datetime.date, scenario_id: int) -> Money:
        if scenario_id == ACTUAL_SCENARIO_ID:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(p.amount),0) AS bal FROM postings p"
                " JOIN transactions t ON t.id = p.txn_id"
                " WHERE p.account_id=? AND t.scenario_id=? AND t.posted=1 AND t.date<=?",
                (account_id, ACTUAL_SCENARIO_ID, _iso(at)),
            ).fetchone()
            return Money(amount=row["bal"])

        sc = self._conn.execute(
            "SELECT fork_date FROM scenarios WHERE id=?", (scenario_id,)
        ).fetchone()
        if sc is None or sc["fork_date"] is None:
            raise DomainNotFoundError(
                "시나리오가 없습니다",
                code="scenario_not_found",
                context={"scenario_id": scenario_id},
            )
        fork = sc["fork_date"]
        row = self._conn.execute(
            "SELECT COALESCE(SUM(p.amount),0) AS bal FROM postings p"
            " JOIN transactions t ON t.id = p.txn_id"
            " WHERE p.account_id=? AND t.posted=1 AND ("
            f"   {self._ACTUAL_BEFORE_FORK}"
            "   OR (t.scenario_id=? AND t.date >= ? AND t.date <= ?)"  # 시나리오 자신
            " )",
            (account_id, ACTUAL_SCENARIO_ID, fork, fork, scenario_id, fork, _iso(at)),
        ).fetchone()
        return Money(amount=row["bal"])

    def actual_base_net_worth(self, fork: datetime.date) -> int:
        """시나리오 시뮬레이션의 시작 순자산 — fork 경계의 actual 쪽만.

        (date < fork) + (date = fork 인 수동 입력). 규칙 생성분 제외 이유는
        클래스 docstring 참조.
        """
        row = self._conn.execute(
            "SELECT COALESCE(SUM(p.amount),0) AS nw FROM postings p"
            " JOIN transactions t ON t.id = p.txn_id"
            " JOIN accounts a ON a.id = p.account_id"
            " WHERE a.type IN ('asset','liability') AND t.posted=1 AND "
            f"  {self._ACTUAL_BEFORE_FORK}",
            (ACTUAL_SCENARIO_ID, _iso(fork), _iso(fork)),
        ).fetchone()
        return row["nw"]

    def net_worth_at(self, at: datetime.date, scenario_id: int) -> int:
        """순자산 = 자산·부채 계정 posting의 합 (fold 의미론은 balance_at과 동일)."""
        nw_filter = "a.type IN ('asset','liability')"
        if scenario_id == ACTUAL_SCENARIO_ID:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(p.amount),0) AS nw FROM postings p"
                " JOIN transactions t ON t.id = p.txn_id"
                " JOIN accounts a ON a.id = p.account_id"
                f" WHERE {nw_filter} AND t.scenario_id=? AND t.posted=1 AND t.date<=?",
                (ACTUAL_SCENARIO_ID, _iso(at)),
            ).fetchone()
            return row["nw"]

        sc = self._conn.execute(
            "SELECT fork_date FROM scenarios WHERE id=?", (scenario_id,)
        ).fetchone()
        if sc is None or sc["fork_date"] is None:
            raise DomainNotFoundError(
                "시나리오가 없습니다",
                code="scenario_not_found",
                context={"scenario_id": scenario_id},
            )
        fork = sc["fork_date"]
        row = self._conn.execute(
            "SELECT COALESCE(SUM(p.amount),0) AS nw FROM postings p"
            " JOIN transactions t ON t.id = p.txn_id"
            " JOIN accounts a ON a.id = p.account_id"
            f" WHERE {nw_filter} AND t.posted=1 AND ("
            f"   {self._ACTUAL_BEFORE_FORK}"
            "   OR (t.scenario_id=? AND t.date >= ? AND t.date <= ?)"
            " )",
            (ACTUAL_SCENARIO_ID, fork, fork, scenario_id, fork, _iso(at)),
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
