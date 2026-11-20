"""Opt-in compensation of a single imported expense, retaining its original journal."""

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from moneymap.domain.errors import (
    DomainConflictError,
    DomainValidationError,
    DomainUnavailableError,
)
from .backup import run_import_backup
from .common import _account_write
from .database import connect
from .fx import write_trade

ELIGIBLE_ROWS = """SELECT t.id transaction_id,t.date day,t.description,t.edit_version,
    v.source_hash,v.source_file,v.source_row,b.account_id bank_id,e.account_id expense_id,
    e.amount cash FROM transaction_import_provenance v JOIN transactions t ON t.id=v.txn_id
    JOIN postings e ON e.txn_id=t.id JOIN accounts expense ON expense.id=e.account_id
    JOIN postings b ON b.txn_id=t.id JOIN accounts bank ON bank.id=b.account_id
    WHERE t.scenario_id=1 AND t.posted=1 AND expense.type='expense'
    AND bank.type='asset'
    AND v.raw_left_type='비용' AND v.raw_left_account='원화에서달러로환전'
    AND v.raw_right_type='자산' AND trim(v.raw_right_account)<>''
    AND length(v.source_hash)=64 AND v.source_hash NOT GLOB '*[^0-9a-f]*'
    AND trim(v.source_file)<>'' AND v.raw_date=t.date AND v.raw_amount=CAST(e.amount AS TEXT)
    AND e.amount>0 AND b.amount=-e.amount AND b.currency='KRW' AND e.currency='KRW'
    AND bank.currency='KRW' AND expense.currency='KRW'
    AND (SELECT count(*) FROM postings WHERE txn_id=t.id)=2"""
CANDIDATES = (
    ELIGIBLE_ROWS + " AND NOT EXISTS (SELECT 1 FROM fx_trades WHERE legacy_txn=t.id)"
)


def candidates(conn):
    return [
        dict(r) | {"cash": str(r["cash"])}
        for r in conn.execute(CANDIDATES + " ORDER BY t.date,t.id")
    ]


def _balances(conn, row, currency):
    # Read all posted entries, including the preserved source and previous conversions.
    accounts = {"bank": row["bank_id"], "expense": row["expense_id"]}
    currencies = {
        "bank": "KRW",
        "expense": "KRW",
        "fee": "KRW",
        "krw_clearing": "KRW",
        "holding": currency,
        "native_clearing": currency,
    }
    for field, role in (
        ("fee", "fee"),
        ("holding", "holding"),
        ("krw_clearing", "clearing"),
        ("native_clearing", "clearing"),
    ):
        found = conn.execute(
            "SELECT account_id FROM fx_accounts WHERE role=? AND currency=?",
            (role, currencies[field]),
        ).fetchone()
        accounts[field] = found[0] if found else None
    return {
        k: str(
            sum(
                r[0]
                for r in conn.execute(
                    """SELECT p.amount FROM postings p JOIN transactions t ON t.id=p.txn_id
        WHERE t.scenario_id=1 AND t.posted=1 AND p.account_id=? AND p.currency=?""",
                    (aid, currencies[k]),
                )
            )
        )
        for k, aid in accounts.items()
    }


def preview(conn, selection):
    row = conn.execute(
        CANDIDATES + " AND t.id=?", (selection.transaction_id,)
    ).fetchone()
    if not row:
        raise DomainConflictError("이관할 원본 비용 행을 다시 확인하세요")
    trade = selection.trade
    if (
        trade.currency,
        trade.side,
        trade.bank_id,
        trade.day.isoformat(),
        int(trade.cash),
    ) != ("USD", "buy", row["bank_id"], row["day"], row["cash"]):
        raise DomainValidationError(
            "원본의 일자·통장·출금액과 USD 매수 조건이 일치해야 합니다"
        )
    before = _balances(conn, row, trade.currency)
    delta = dict(
        bank=0,
        expense=-int(trade.cash),
        fee=int(trade.fee),
        krw_clearing=trade.principal,
        holding=trade.minor,
        native_clearing=-trade.minor,
    )
    after = {k: str(int(before[k]) + n) for k, n in delta.items()}
    result = dict(
        original=dict(row) | {"cash": str(row["cash"])}, before=before, after=after
    )
    data = json.dumps(
        [trade.model_dump(mode="json"), result], ensure_ascii=False, sort_keys=True
    )
    return result | {"preview_hash": hashlib.sha256(data.encode()).hexdigest()}


def apply(conn, command):
    with _account_write(conn):
        existing = conn.execute(
            "SELECT * FROM fx_trades WHERE legacy_txn=?", (command.transaction_id,)
        ).fetchone()
        if existing:
            if not conn.execute(
                ELIGIBLE_ROWS + " AND t.id=?", (command.transaction_id,)
            ).fetchone():
                raise DomainConflictError("이관할 원본 비용 행을 다시 확인하세요")
            trade = command.trade
            matches = all(
                str(existing[k]) == str(getattr(trade, k))
                for k in (
                    "day",
                    "side",
                    "bank_id",
                    "currency",
                    "minor",
                    "principal",
                    "rate",
                    "rate_date",
                    "source",
                )
            )
            if (
                existing["preview_hash"] == command.preview_hash
                and matches
                and existing["fee"] == int(trade.fee)
            ):
                return {"id": existing["id"]}
            raise DomainConflictError("이미 이관된 원본입니다")
        impact = preview(conn, command)
        if impact["preview_hash"] != command.preview_hash:
            raise DomainConflictError(
                "원본 또는 대사 잔액이 변경되었습니다. 미리보기를 다시 확인하세요"
            )
        path = Path(conn.execute("PRAGMA database_list").fetchone()[2])
        # Separate read handle snapshots the exact pre-write state under our reserved writer lock.
        try:
            with closing(connect(str(path))) as reader:
                backup = run_import_backup(
                    reader, path.parent / "backups", command.preview_hash
                )
        except (OSError, sqlite3.Error) as exc:
            raise DomainUnavailableError(
                "이관 전 백업을 저장하지 못했습니다. 백업 폴더와 여유 공간을 확인하세요"
            ) from exc
        saved = write_trade(
            conn,
            command.trade,
            legacy=impact["original"],
            backup=backup.name,
            preview_hash=command.preview_hash,
        )
        if (
            _balances(conn, impact["original"], command.trade.currency)
            != impact["after"]
        ):
            raise DomainConflictError(
                "통화별 대사 결과가 미리보기와 달라 이관을 취소했습니다"
            )
        return {"id": saved}
