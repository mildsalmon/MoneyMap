"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import datetime
import sqlite3

from moneymap.domain.account import Account, AccountType
from moneymap.domain.money import Money
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID, Scenario
from moneymap.domain.schedule import Schedule
from moneymap.domain.transaction import Posting, Transaction

_D = datetime.date.fromisoformat


def _iso(d: datetime.date | None) -> str | None:
    return d.isoformat() if d is not None else None


class SystemClock:
    def today(self) -> datetime.date:
        return datetime.date.today()


class SqliteAccountRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, account: Account) -> Account:
        if account.id is None:
            cur = self._conn.execute(
                "INSERT INTO accounts (name, type, parent_id, currency, archived, is_placeholder) "
                "VALUES (?,?,?,?,?,?)",
                (account.name, account.type.value, account.parent_id, account.currency,
                 int(account.archived), int(account.is_placeholder)),
            )
            account = account.model_copy(update={"id": cur.lastrowid})
        else:
            self._conn.execute(
                "UPDATE accounts SET name=?, type=?, parent_id=?, currency=?, archived=?, is_placeholder=? "
                "WHERE id=?",
                (account.name, account.type.value, account.parent_id, account.currency,
                 int(account.archived), int(account.is_placeholder), account.id),
            )
        self._conn.commit()
        return account

    def has_children(self, account_id: int) -> bool:
        return (
            self._conn.execute(
                "SELECT 1 FROM accounts WHERE parent_id=? LIMIT 1", (account_id,)
            ).fetchone()
            is not None
        )

    def has_postings(self, account_id: int) -> bool:
        return (
            self._conn.execute(
                "SELECT 1 FROM postings WHERE account_id=? LIMIT 1", (account_id,)
            ).fetchone()
            is not None
        )

    @staticmethod
    def _row_to_account(row: sqlite3.Row) -> Account:
        return Account(
            id=row["id"],
            name=row["name"],
            type=AccountType(row["type"]),
            parent_id=row["parent_id"],
            currency=row["currency"],
            archived=bool(row["archived"]),
            is_placeholder=bool(row["is_placeholder"]),
        )

    def find_by_id(self, account_id: int) -> Account | None:
        row = self._conn.execute(
            "SELECT * FROM accounts WHERE id=?", (account_id,)
        ).fetchone()
        return self._row_to_account(row) if row else None

    def find_by_name(self, name: str) -> Account | None:
        row = self._conn.execute(
            "SELECT * FROM accounts WHERE name=?", (name,)
        ).fetchone()
        return self._row_to_account(row) if row else None

    def find_all(self) -> list[Account]:
        rows = self._conn.execute("SELECT * FROM accounts ORDER BY id").fetchall()
        return [self._row_to_account(r) for r in rows]


def _insert_txn(conn: sqlite3.Connection, txn: Transaction) -> int:
    """커밋 없이 거래 + postings를 넣고 posted=1로 확정한다 (트리거 검산 시점).

    호출자가 트랜잭션 경계(commit/rollback)를 소유한다 — save()는 거래 1건,
    apply_materialization()은 계획 전체를 하나의 경계로 묶는다.
    """
    cur = conn.execute(
        "INSERT INTO transactions (scenario_id, date, description, source_rule_id, posted) "
        "VALUES (?,?,?,?,0)",
        (txn.scenario_id, _iso(txn.date), txn.description, txn.source_rule_id),
    )
    txn_id = cur.lastrowid
    assert txn_id is not None
    conn.executemany(
        "INSERT INTO postings (txn_id, account_id, amount, currency) VALUES (?,?,?,?)",
        [
            (txn_id, p.account_id, p.amount.amount, p.amount.currency)
            for p in txn.postings
        ],
    )
    conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (txn_id,))
    return txn_id


class SqliteTransactionRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, txn: Transaction) -> Transaction:
        """거래 1건을 단일 SQL 트랜잭션으로 저장. 실패 시 전체 롤백."""
        if txn.id is not None:
            raise NotImplementedError("v1: 거래 수정은 삭제 후 재입력으로 처리")
        try:
            txn_id = _insert_txn(self._conn, txn)
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        return txn.model_copy(update={"id": txn_id})

    def delete(self, txn_id: int) -> bool:
        """거래 삭제. 확정 거래는 먼저 un-post해서 변조 차단 트리거를 통과시킨다.

        (트리거는 posted=1 거래의 postings 변조를 막지만, posted 0→ 되돌림은
        삭제 경로로만 쓰이며 같은 트랜잭션 안에서 행 전체가 사라진다.)
        반환: 실제로 삭제됐으면 True.
        """
        try:
            cur = self._conn.execute(
                "UPDATE transactions SET posted=0 WHERE id=?", (txn_id,)
            )
            if cur.rowcount == 0:
                self._conn.rollback()
                return False
            self._conn.execute("DELETE FROM postings WHERE txn_id=?", (txn_id,))
            self._conn.execute("DELETE FROM transactions WHERE id=?", (txn_id,))
            self._conn.commit()
            return True
        except Exception:
            self._conn.rollback()
            raise

    def find_by_scenario(
        self,
        scenario_id: int,
        start: datetime.date | None = None,
        end: datetime.date | None = None,
    ) -> list[Transaction]:
        sql = "SELECT * FROM transactions WHERE scenario_id=? AND posted=1"
        params: list[object] = [scenario_id]
        if start is not None:
            sql += " AND date >= ?"
            params.append(_iso(start))
        if end is not None:
            sql += " AND date <= ?"
            params.append(_iso(end))
        sql += " ORDER BY date, id"
        txns = []
        for row in self._conn.execute(sql, params).fetchall():
            postings = [
                Posting(
                    account_id=p["account_id"],
                    amount=Money(amount=p["amount"], currency=p["currency"]),
                )
                for p in self._conn.execute(
                    "SELECT * FROM postings WHERE txn_id=? ORDER BY id", (row["id"],)
                ).fetchall()
            ]
            txns.append(
                Transaction(
                    id=row["id"],
                    scenario_id=row["scenario_id"],
                    date=_D(row["date"]),
                    description=row["description"],
                    source_rule_id=row["source_rule_id"],
                    postings=postings,
                )
            )
        return txns


class SqliteScenarioRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, scenario: Scenario) -> Scenario:
        if scenario.id is None:
            cur = self._conn.execute(
                "INSERT INTO scenarios (name, base_scenario_id, fork_date) VALUES (?,?,?)",
                (scenario.name, scenario.base_scenario_id, _iso(scenario.fork_date)),
            )
            scenario = scenario.model_copy(update={"id": cur.lastrowid})
        else:
            self._conn.execute(
                "UPDATE scenarios SET name=? WHERE id=?", (scenario.name, scenario.id)
            )
        self._conn.commit()
        return scenario

    @staticmethod
    def _row_to_scenario(row: sqlite3.Row) -> Scenario:
        return Scenario(
            id=row["id"],
            name=row["name"],
            base_scenario_id=row["base_scenario_id"],
            fork_date=_D(row["fork_date"]) if row["fork_date"] else None,
        )

    def find_by_id(self, scenario_id: int) -> Scenario | None:
        row = self._conn.execute(
            "SELECT * FROM scenarios WHERE id=?", (scenario_id,)
        ).fetchone()
        return self._row_to_scenario(row) if row else None

    def list_all(self) -> list[Scenario]:
        rows = self._conn.execute("SELECT * FROM scenarios ORDER BY id").fetchall()
        return [self._row_to_scenario(r) for r in rows]


class SqliteRecurringRuleRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, rule: RecurringRule) -> RecurringRule:
        if rule.id is None:
            cur = self._conn.execute(
                "INSERT INTO recurring_rules "
                "(scenario_id, description, from_account_id, to_account_id, amount, currency,"
                " schedule, start_date, end_date, last_materialized) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    rule.scenario_id, rule.description,
                    rule.from_account_id, rule.to_account_id,
                    rule.amount.amount, rule.amount.currency,
                    rule.schedule.spec, _iso(rule.start_date),
                    _iso(rule.end_date), _iso(rule.last_materialized),
                ),
            )
            rule = rule.model_copy(update={"id": cur.lastrowid})
        else:
            self._conn.execute(
                "UPDATE recurring_rules SET description=?, from_account_id=?, to_account_id=?,"
                " amount=?, currency=?, schedule=?, start_date=?, end_date=?, last_materialized=?"
                " WHERE id=?",
                (
                    rule.description, rule.from_account_id, rule.to_account_id,
                    rule.amount.amount, rule.amount.currency,
                    rule.schedule.spec, _iso(rule.start_date),
                    _iso(rule.end_date), _iso(rule.last_materialized), rule.id,
                ),
            )
        self._conn.commit()
        return rule

    def find_by_scenario(self, scenario_id: int) -> list[RecurringRule]:
        rows = self._conn.execute(
            "SELECT * FROM recurring_rules WHERE scenario_id=? ORDER BY id",
            (scenario_id,),
        ).fetchall()
        return [
            RecurringRule(
                id=r["id"],
                scenario_id=r["scenario_id"],
                description=r["description"],
                from_account_id=r["from_account_id"],
                to_account_id=r["to_account_id"],
                amount=Money(amount=r["amount"], currency=r["currency"]),
                schedule=Schedule(spec=r["schedule"]),
                start_date=_D(r["start_date"]),
                end_date=_D(r["end_date"]) if r["end_date"] else None,
                last_materialized=_D(r["last_materialized"]) if r["last_materialized"] else None,
            )
            for r in rows
        ]


def apply_materialization(conn: sqlite3.Connection, plan) -> list[int]:
    """MaterializationPlan을 단일 SQL 트랜잭션으로 적용한다 (D9 원자성).

    거래 생성 전부 + 규칙 watermark(last_materialized) 갱신이 한 덩어리 —
    도중에 죽으면 전부 롤백되고 다음 실행이 같은 계획을 다시 세운다.

    동시 실행 방어 (낙관적 잠금): watermark를 '계획 수립 시점 값과 같을 때만'
    조건부 UPDATE로 먼저 선점한다. 다른 실행이 이미 적용했다면 rowcount=0 →
    전체 롤백하고 빈 목록 반환. 두 클라이언트가 같은 계획을 동시에 적용해도
    이중 기입은 구조적으로 불가능하다.

    반환: 생성된 거래 id 목록 (선점 실패 시 []).
    """
    txn_ids: list[int] = []
    try:
        # 1) watermark 선점 — 계획의 전제(expected)가 여전히 참일 때만
        for rule_id, watermark in plan.watermarks.items():
            cur = conn.execute(
                "UPDATE recurring_rules SET last_materialized=?"
                " WHERE id=? AND last_materialized IS ?",
                (_iso(watermark), rule_id, _iso(plan.expected.get(rule_id))),
            )
            if cur.rowcount == 0:  # 동시 실행이 먼저 적용함
                conn.rollback()
                return []
        # 2) 거래 생성
        for txn in plan.transactions:
            txn_ids.append(_insert_txn(conn, txn))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return txn_ids


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
    _ACTUAL_BEFORE_FORK = (
        "(t.scenario_id=? AND (t.date < ? OR (t.date = ? AND t.source_rule_id IS NULL)))"
    )

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def balance_at(
        self, account_id: int, at: datetime.date, scenario_id: int
    ) -> Money:
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
            raise ValueError(f"시나리오가 없거나 fork_date가 없습니다: id={scenario_id}")
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
            raise ValueError(f"시나리오가 없거나 fork_date가 없습니다: id={scenario_id}")
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
