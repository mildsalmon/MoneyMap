"""Compare and post against one consistent snapshot of the actual ledger."""
import hashlib
import sqlite3

from moneymap.domain.account import Account, AccountType
from moneymap.domain.errors import DomainConflictError, DomainValidationError
from moneymap.domain.money import Money
from moneymap.domain.reconciliation import Adjustment, Statement
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID
from moneymap.domain.services import validate_postable_accounts
from moneymap.domain.transaction import Posting, Transaction

from .account_history import dated_accounts
from .common import _account_write
from .transactions import _insert_txn


def _available(accounts: list[Account], account_id: int) -> Account:
    validate_postable_accounts(accounts, [account_id])
    account = next(account for account in accounts if account.id == account_id)
    if account.archived or account.is_system:
        raise DomainValidationError("활성 사용자 계정을 선택하세요", code="account_unavailable")
    return account


def _compare(conn: sqlite3.Connection, statement: Statement, accounts: list[Account]) -> dict:
    account = _available(accounts, statement.account_id)
    if account.type not in (AccountType.ASSET, AccountType.LIABILITY):
        raise DomainValidationError("대사할 자산 또는 부채 계정을 선택하세요")

    sign = account.display_multiplier()
    revision = hashlib.sha256(statement.model_dump_json().encode())
    revision.update(str(sign).encode())
    raw = 0
    # The history index already partitions posted actual entries by currency.
    # edit_version also changes on edits that leave the closing balance intact.
    for row in conn.execute("""
        SELECT h.balance, t.edit_version FROM account_balance_history h
        JOIN transactions t ON t.id=h.txn_id
        WHERE h.account_id=? AND h.currency=? AND h.date<=?
        ORDER BY h.date,h.txn_id
    """, (account.id, statement.currency, statement.closing_date.isoformat())):
        raw = row["balance"]
        revision.update(row["edit_version"].encode())
    ledger = raw * sign
    delta = int(statement.statement_minor) - ledger
    return dict(ledger_minor=str(ledger), difference_minor=str(delta),
                posting_minor=str(delta * sign), preview_version=revision.hexdigest())


def preview(conn: sqlite3.Connection, statement: Statement) -> dict:
    conn.execute("BEGIN")
    try:
        return _compare(conn, statement, dated_accounts(conn, statement.closing_date)[0])
    finally:
        conn.rollback()


def confirm(conn: sqlite3.Connection, command: Adjustment) -> dict:
    statement = command.statement
    key = str(command.request_id)
    digest = hashlib.sha256(command.model_dump_json().encode()).hexdigest()
    with _account_write(conn):
        receipt = conn.execute("SELECT * FROM reconciliation_requests WHERE request_id=?", (key,)).fetchone()
        if receipt:
            if receipt["payload_hash"] != digest:
                raise DomainConflictError("이미 다른 조정에 사용한 요청입니다", code="request_id_conflict")
            return {"transaction_id": receipt["txn_id"]}

        accounts = dated_accounts(conn, statement.closing_date)[0]
        comparison = _compare(conn, statement, accounts)
        if comparison["preview_version"] != command.preview_version:
            raise DomainConflictError("마감일 장부가 바뀌었습니다. 잔액을 다시 계산하세요", code="stale_preview")
        amount = int(comparison["posting_minor"])
        if not amount:
            raise DomainValidationError("잔액이 일치해 조정할 차이가 없습니다")
        if abs(amount) > 2**63 - 1:
            raise DomainValidationError("조정 분개가 저장 가능한 금액 범위를 넘습니다")
        if command.counterpart_id == statement.account_id:
            raise DomainValidationError("대사 계정과 다른 상대 계정을 선택하세요")
        _available(accounts, command.counterpart_id)
        adjustment = Transaction(
            scenario_id=ACTUAL_SCENARIO_ID, date=statement.closing_date,
            description="잔액 대사 조정", memo=command.reason,
            postings=[
                Posting(account_id=statement.account_id, amount=Money(amount=amount, currency=statement.currency)),
                Posting(account_id=command.counterpart_id, amount=Money(amount=-amount, currency=statement.currency)),
            ],
        )
        txn_id = _insert_txn(conn, adjustment)
        conn.execute("INSERT INTO reconciliation_requests(request_id,payload_hash,txn_id) VALUES(?,?,?)",
                     (key, digest, txn_id))
        return {"transaction_id": txn_id}
