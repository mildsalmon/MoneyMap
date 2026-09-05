"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import datetime
import sqlite3
from itertools import groupby

from moneymap.domain.account import (
    OPENING_BALANCE_ACCOUNT_NAME,
)
from moneymap.domain.errors import (
    DomainConflictError,
    DomainError,
    DomainNotFoundError,
)
from moneymap.domain.money import Money
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID
from moneymap.domain.services import (
    opening_balance_posting_amount,
    validate_postable_accounts,
)
from moneymap.domain.transaction import Posting, Transaction

from .accounts import SqliteAccountRepository
from .common import _D, _iso, _translate_integrity_error


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
            self._conn.execute("BEGIN IMMEDIATE")
            validate_postable_accounts(
                SqliteAccountRepository(self._conn).find_all(),
                [p.account_id for p in txn.postings],
            )
            txn_id = _insert_txn(self._conn, txn)
            self._conn.commit()
        except Exception:
            self._conn.rollback()
            raise
        return txn.model_copy(update={"id": txn_id})

    def find_opening_balances(self, account_id: int | None = None) -> list[dict]:
        """exact two-leg 개시잔액 구조를 한 번의 집계 SQL로 식별한다."""
        sql = """
        WITH candidate_postings AS (
          SELECT
            t.id AS transaction_id,
            t.date AS date,
            p.account_id AS account_id,
            p.amount AS amount,
            CASE
              WHEN a.is_system=1 AND a.type='equity' AND a.name=? THEN 1
              ELSE 0
            END AS is_opening
          FROM transactions t
          JOIN postings p ON p.txn_id=t.id
          JOIN accounts a ON a.id=p.account_id
          WHERE t.scenario_id=? AND t.posted=1 AND t.source_rule_id IS NULL
        ),
        opening_matches AS (
          SELECT
            transaction_id,
            date,
            MAX(CASE WHEN is_opening=0 THEN account_id END) AS account_id,
            MAX(CASE WHEN is_opening=0 THEN amount END) AS signed_amount
          FROM candidate_postings
          GROUP BY transaction_id, date
          HAVING COUNT(*)=2
             AND SUM(amount)=0
             AND SUM(is_opening)=1
             AND SUM(CASE WHEN is_opening=0 AND amount != 0 THEN 1 ELSE 0 END)=1
        )
        SELECT transaction_id, date, account_id, signed_amount
        FROM opening_matches
        """
        params: list[object] = [OPENING_BALANCE_ACCOUNT_NAME, ACTUAL_SCENARIO_ID]
        if account_id is not None:
            sql += " WHERE account_id=?"
            params.append(account_id)
        sql += " ORDER BY transaction_id"
        return [
            {
                "account_id": row["account_id"],
                "transaction_id": row["transaction_id"],
                "date": row["date"],
                "state": "positive" if row["signed_amount"] > 0 else "negative",
            }
            for row in self._conn.execute(sql, params).fetchall()
        ]

    def create_opening_balance(
        self,
        account_id: int,
        date: datetime.date,
        amount: int,
        state: str,
    ) -> Transaction:
        """개시잔액 중복 검사와 균형 거래 생성을 한 경계로 묶는다."""
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            accounts = SqliteAccountRepository(self._conn)
            account = accounts.find_by_id(account_id)
            if account is None:
                raise DomainNotFoundError(
                    "계정이 없습니다",
                    code="account_not_found",
                )
            signed_amount = opening_balance_posting_amount(
                account,
                amount,
                state,
                has_children=accounts.has_children(account_id),
            )
            if self.find_opening_balances(account_id):
                raise DomainConflictError(
                    "이 계정에는 이미 개시잔액이 기록되어 있습니다",
                    code="opening_already_recorded",
                )
            opening_row = self._conn.execute(
                "SELECT * FROM accounts "
                "WHERE name=? AND type='equity' AND is_system=1 "
                "ORDER BY id LIMIT 1",
                (OPENING_BALANCE_ACCOUNT_NAME,),
            ).fetchone()
            if opening_row is None:
                raise DomainNotFoundError(
                    "개시잔액 시스템 계정이 없습니다",
                    code="opening_account_not_found",
                )
            txn = Transaction(
                scenario_id=ACTUAL_SCENARIO_ID,
                date=date,
                description=f"개시잔액: {account.name}",
                postings=[
                    Posting(account_id=account_id, amount=Money(amount=signed_amount)),
                    Posting(
                        account_id=opening_row["id"],
                        amount=Money(amount=-signed_amount),
                    ),
                ],
            )
            txn_id = _insert_txn(self._conn, txn)
            self._conn.commit()
            return txn.model_copy(update={"id": txn_id})
        except DomainError:
            self._conn.rollback()
            raise
        except sqlite3.IntegrityError as exc:
            self._conn.rollback()
            translated = _translate_integrity_error(exc)
            if translated is not None:
                raise translated from exc
            raise
        except Exception:
            self._conn.rollback()
            raise

    def delete(self, txn_id: int, *, scenario_id: int | None = None) -> bool:
        """거래 삭제. 확정 거래는 먼저 un-post해서 변조 차단 트리거를 통과시킨다.

        (트리거는 posted=1 거래의 postings 변조를 막지만, posted 0→ 되돌림은
        삭제 경로로만 쓰이며 같은 트랜잭션 안에서 행 전체가 사라진다.)
        반환: 실제로 삭제됐으면 True.
        """
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            cur = self._conn.execute(
                "UPDATE transactions SET posted=0 WHERE id=? AND (? IS NULL OR scenario_id=?)",
                (txn_id, scenario_id, scenario_id),
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


class ScenarioTransactionWriter:
    """Commit-free child primitive. Its owning UoW rolls back every posting."""

    def __init__(self, conn):
        self._conn = conn

    def save(self, txn: Transaction) -> Transaction:
        if not self._conn.in_transaction:
            raise RuntimeError("Scenario writers require an active UnitOfWork")
        if txn.id is not None:
            raise NotImplementedError("Transaction updates are not implemented")
        return txn.model_copy(update={"id": _insert_txn(self._conn, txn)})

    def list_owned(self, sid: int) -> list[Transaction]:
        rows = self._conn.execute(
            "SELECT t.id,t.date,t.description,p.account_id,p.amount,p.currency "
            "FROM transactions t JOIN postings p ON p.txn_id=t.id "
            "WHERE t.scenario_id=? AND t.source_rule_id IS NULL AND t.posted=1 "
            "ORDER BY t.date,t.id,p.id",
            (sid,),
        )
        result = []
        for tid, items in groupby(rows, key=lambda r: r["id"]):
            items = list(items)
            result.append(
                Transaction(
                    id=tid,
                    scenario_id=sid,
                    date=_D(items[0]["date"]),
                    description=items[0]["description"],
                    postings=[
                        Posting(
                            account_id=p["account_id"],
                            amount=Money(amount=p["amount"], currency=p["currency"]),
                        )
                        for p in items
                    ],
                )
            )
        return result

    def replace(self, txn: Transaction) -> Transaction:
        if not self._conn.in_transaction:
            raise RuntimeError("Transaction updates require an active UnitOfWork")
        cur = self._conn.execute(
            "UPDATE transactions SET posted=0 WHERE id=? AND scenario_id=? "
            "AND source_rule_id IS NULL AND posted=1",
            (txn.id, txn.scenario_id),
        )
        if cur.rowcount != 1:
            raise DomainNotFoundError(
                "예정 거래가 없습니다", code="transaction_not_found"
            )
        self._conn.execute("DELETE FROM postings WHERE txn_id=?", (txn.id,))
        self._conn.execute(
            "UPDATE transactions SET date=?,description=? WHERE id=?",
            (_iso(txn.date), txn.description, txn.id),
        )
        self._conn.executemany(
            "INSERT INTO postings(txn_id,account_id,amount,currency) VALUES(?,?,?,?)",
            [
                (txn.id, p.account_id, p.amount.amount, p.amount.currency)
                for p in txn.postings
            ],
        )
        self._conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (txn.id,))
        return txn
