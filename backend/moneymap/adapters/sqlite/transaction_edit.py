"""Atomic editing and a terminal receipt fence for ambiguous network results.

save -> lock -> validate -> unpost -> rows/tags -> repost -> receipt -> commit
resolve -> same lock -> receipt exists? return : seal not_applied
A late save cannot pass a sealed request. No write runs inside a read snapshot.
"""
import hashlib
import json
import sqlite3

from moneymap.domain.account import OPENING_BALANCE_ACCOUNT_NAME
from moneymap.domain.errors import DomainConflictError, DomainNotFoundError, DomainValidationError
from moneymap.domain.transaction_edit import TransactionDetail, TransactionEdit, edited_postings, validate_balanced
from moneymap.domain.transaction_input import normalize_item_key
from .account_history import dated_accounts
from .living_categories import assign_category
from .common import _account_write
from .transactions import SqliteTransactionRepository, _load_tags, _replace_tags


def find_detail(conn: sqlite3.Connection, txn_id: int) -> TransactionDetail | None:
    row = conn.execute("SELECT * FROM transactions WHERE id=? AND scenario_id=1 AND posted=1", (txn_id,)).fetchone()
    if row is None:
        return None
    postings = conn.execute(
        "SELECT p.id AS posting_id,p.account_id,p.amount,p.currency,c.category_id,a.is_system,a.type,a.name "
        "FROM postings p JOIN accounts a ON a.id=p.account_id "
        "LEFT JOIN posting_living_categories c ON c.posting_id=p.id WHERE p.txn_id=? ORDER BY p.id", (txn_id,)
    ).fetchall()
    systems = [p for p in postings if p["is_system"]]
    protected = (row["source_rule_id"] is None and row["entry_origin"] != "rule" and len(postings) == 2
        and sum(p["amount"] for p in postings) == 0 and len(systems) == 1
        and systems[0]["name"] == OPENING_BALANCE_ACCOUNT_NAME and systems[0]["type"] == "equity")
    kind = ("legacy_opening_zero" if all(p["amount"] == 0 for p in postings) else "opening") if protected else "regular"
    return TransactionDetail(id=row["id"], version=row["edit_version"], date=row["date"],
        description=row["description"], memo=row["memo"], tags=_load_tags(conn, txn_id),
        source_rule_id=row["source_rule_id"], entry_origin=row["entry_origin"],
        postings=[{k: p[k] for k in ("posting_id", "account_id", "amount", "currency", "category_id")} for p in postings],
        kind=kind, opening_system_id=systems[0]["account_id"] if protected else None,
        editable=all(p["currency"] == "KRW" for p in postings) and (not systems or protected))


def _fingerprint(command: TransactionEdit) -> str:
    body = command.model_dump(mode="json", exclude={"request_id"})
    # Retain pre-migration receipt hashes. Omission preserves the category;
    # explicit null clears it and must have a different request fingerprint.
    for row, posting in zip(body["postings"] or [], command.postings or []):
        if "category_id" not in posting.model_fields_set:
            del row["category_id"]
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _receipt(conn, txn_id, command, fingerprint):
    receipt = conn.execute("SELECT * FROM transaction_edit_requests WHERE request_id=?", (command.request_id,)).fetchone()
    if receipt is not None and (receipt["txn_id"] != txn_id or receipt["expected_version"] != command.expected_version or receipt["payload_hash"] != fingerprint):
        raise DomainConflictError("이미 사용한 저장 요청 번호입니다. 최신 거래를 확인하세요", code="edit_request_mismatch")
    return receipt


def _result(conn, txn_id, request_id, outcome, version):
    current = find_detail(conn, txn_id)
    return {"request_id": request_id, "outcome": outcome, "result_version": version,
            "transaction": current.model_dump(mode="json") if current else None}


def _record(conn, txn_id, command, fingerprint, outcome, version=None):
    conn.execute("INSERT INTO transaction_edit_requests(request_id,txn_id,expected_version,payload_hash,outcome,result_version) VALUES(?,?,?,?,?,?)",
                 (command.request_id, txn_id, command.expected_version, fingerprint, outcome, version))


def update_transaction(conn: sqlite3.Connection, txn_id: int, command: TransactionEdit):
    fingerprint = _fingerprint(command)
    with _account_write(conn):
        receipt = _receipt(conn, txn_id, command, fingerprint)
        if receipt is not None:
            return _result(conn, txn_id, command.request_id, receipt["outcome"], receipt["result_version"])
        original = find_detail(conn, txn_id)
        if original is None:
            raise DomainNotFoundError("거래가 없습니다", code="transaction_not_found")
        if original.version != command.expected_version:
            raise DomainConflictError("다른 변경이 있습니다. 작성 내용은 유지하고 최신 거래를 확인하세요", code="transaction_version_conflict")
        if not original.editable:
            raise DomainValidationError("원화 일반 거래와 개시잔액만 수정할 수 있습니다. 원본은 유지했습니다", code="transaction_edit_unsupported")
        accounts, _ = dated_accounts(conn, command.date)
        postings = edited_postings(command, original, accounts)
        validate_balanced(command, postings)
        if original.kind != "regular" and command.opening.signed_amount != 0:
            existing = SqliteTransactionRepository(conn).find_opening_balances(command.opening.account_id)
            if any(row["transaction_id"] != txn_id for row in existing):
                raise DomainConflictError("대상 계정에 이미 개시잔액이 있습니다", code="opening_already_recorded")
        original_by_id = {p.posting_id: p for p in original.postings}
        financial_changed = command.date != original.date or {
            (p.posting_id, p.account_id, p.amount) for p in postings
        } != {(p.posting_id, p.account_id, p.amount) for p in original.postings}
        if financial_changed:
            conn.execute("UPDATE transactions SET posted=0,date=?,description=?,memo=?,item_key=? WHERE id=?",
                         (command.date.isoformat(), command.description, command.memo, normalize_item_key(command.description), txn_id))
            keep = {p.posting_id for p in postings if p.posting_id is not None}
            for previous in original.postings:
                if previous.posting_id not in keep:
                    conn.execute("DELETE FROM postings WHERE id=? AND txn_id=?", (previous.posting_id, txn_id))
        else:
            # Metadata must not unpost/repost an otherwise unchanged ledger.
            conn.execute("UPDATE transactions SET description=?,memo=?,item_key=? WHERE id=?",
                         (command.description, command.memo, normalize_item_key(command.description), txn_id))

        eligible = {a.id for a in accounts if a.type in {"expense", "income"}}
        for posting in postings:
            posting_id = posting.posting_id
            previous = original_by_id.get(posting_id)
            if posting_id is None:
                posting_id = conn.execute("INSERT INTO postings(txn_id,account_id,amount,currency) VALUES(?,?,?,'KRW')",
                                          (txn_id, posting.account_id, posting.amount)).lastrowid
            elif financial_changed:
                conn.execute("UPDATE postings SET account_id=?,amount=? WHERE id=? AND txn_id=?",
                             (posting.account_id, posting.amount, posting_id, txn_id))

            if "category_id" in posting.model_fields_set:
                assign_category(conn, posting_id, posting.category_id)
            elif previous and previous.category_id is not None and posting.account_id not in eligible:
                # An older client can change the account without sending category metadata.
                assign_category(conn, posting_id, None)
        if financial_changed:
            conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (txn_id,))
        _replace_tags(conn, txn_id, command.tags)
        saved = find_detail(conn, txn_id)
        _record(conn, txn_id, command, fingerprint, "applied", saved.version)
        return _result(conn, txn_id, command.request_id, "applied", saved.version)


def resolve_edit(conn: sqlite3.Connection, txn_id: int, command: TransactionEdit):
    fingerprint = _fingerprint(command)
    with _account_write(conn):
        receipt = _receipt(conn, txn_id, command, fingerprint)
        if receipt is not None:
            return _result(conn, txn_id, command.request_id, receipt["outcome"], receipt["result_version"])
        # No live transaction is required: it may have been deleted. The opaque
        # expected version prevents an old request from targeting a reused ID.
        _record(conn, txn_id, command, fingerprint, "not_applied")
        return _result(conn, txn_id, command.request_id, "not_applied", None)
