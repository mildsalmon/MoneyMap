"""Both journal entries, their link and the idempotency receipt commit together."""

from __future__ import annotations

from collections import defaultdict
from fractions import Fraction
from dataclasses import dataclass
from datetime import date

from moneymap.domain.errors import (
    DomainConflictError,
    DomainNotFoundError,
    DomainValidationError,
)
from moneymap.domain.fx import Trade, round_won
from moneymap.domain.money import MINOR_UNITS, Money
from moneymap.domain.services import account_name_key
from moneymap.domain.transaction import Posting, Transaction
from moneymap.domain.transaction_input import normalize_item_key
from .transactions import _insert_txn
from .account_history import posting_accounts_on
from .common import _account_write
from .krw_reporting import KRW_TRANSACTION

ROLES = {
    "holding": ("asset", "외화 현금"),
    "clearing": ("equity", "환전 상대계정"),
    "fee": ("expense", "환전 수수료"),
}


def _system_account(conn, role, currency):
    row = conn.execute(
        "SELECT account_id FROM fx_accounts WHERE role=? AND currency=?",
        (role, currency),
    ).fetchone()
    if row:
        return row[0]
    kind, label = ROLES[role]
    base_name = f"{label} ({currency})"
    names = {
        account_name_key(r[0])
        for r in conn.execute(
            "SELECT name FROM accounts WHERE type=? AND parent_id IS NULL", (kind,)
        )
    }
    name = base_name
    suffix = 1
    while account_name_key(name) in names:
        suffix += 1
        name = f"{base_name} {suffix}"
    account = conn.execute(
        """INSERT INTO accounts(name,type,currency,is_system,position)
        SELECT ?,?,?,1,coalesce(max(position),0)+1 FROM accounts WHERE type=? AND parent_id IS NULL""",
        (name, kind, currency, kind),
    ).lastrowid
    conn.execute("INSERT INTO fx_accounts VALUES (?,?,?)", (role, currency, account))
    return account


def _journal(conn, trade, currency, legs, txn_id=None):
    description = f"{trade.currency} 환전 {'매수' if trade.side == 'buy' else '매도'}"
    txn = Transaction(
        scenario_id=1,
        date=trade.day,
        description=description,
        postings=[
            Posting(account_id=aid, amount=Money(currency=currency, amount=value))
            for aid, value in legs
        ],
    )
    if txn_id is None:
        return _insert_txn(conn, txn)
    conn.execute(
        "UPDATE transactions SET posted=0,date=?,description=?,item_key=? WHERE id=?",
        (trade.day.isoformat(), description, normalize_item_key(description), txn_id),
    )
    conn.execute("DELETE FROM postings WHERE txn_id=?", (txn_id,))
    conn.executemany(
        "INSERT INTO postings(txn_id,account_id,currency,amount) VALUES(?,?,?,?)",
        [(txn_id, p.account_id, currency, p.amount.amount) for p in txn.postings],
    )
    conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (txn_id,))
    return txn_id


def write_trade(
    conn, trade: Trade, *, original=None, legacy=None, backup=None, preview_hash=None
):
    # A selected historical expense already contains the bank withdrawal.
    if legacy:
        cash_account = legacy["expense_id"]
    else:
        bank = posting_accounts_on(conn, trade.day, {trade.bank_id})[trade.bank_id]
        if bank.type != "asset" or bank.currency != "KRW":
            raise DomainValidationError("원화 현금성 자산 계정을 선택하세요")
        cash_account = bank.id
    sign = 1 if trade.side == "buy" else -1
    krw = [
        (cash_account, -sign * int(trade.cash)),
        (_system_account(conn, "clearing", "KRW"), sign * trade.principal),
    ]
    if int(trade.fee):
        krw.append((_system_account(conn, "fee", "KRW"), int(trade.fee)))
    native = [
        (_system_account(conn, "holding", trade.currency), sign * trade.minor),
        (_system_account(conn, "clearing", trade.currency), -sign * trade.minor),
    ]
    if original:
        conn.execute("UPDATE fx_trades SET editing=1 WHERE id=?", (original["id"],))
    krw_id = _journal(conn, trade, "KRW", krw, original and original["krw_txn"])
    native_id = _journal(
        conn, trade, trade.currency, native, original and original["native_txn"]
    )
    fields = dict(
        day=trade.day.isoformat(),
        side=trade.side,
        bank_id=trade.bank_id,
        currency=trade.currency,
        minor=trade.minor,
        cash=int(trade.cash),
        fee=int(trade.fee),
        principal=trade.principal,
        rate=trade.rate,
        rate_date=trade.rate_date.isoformat(),
        source=trade.source,
        krw_txn=krw_id,
        native_txn=native_id,
    )
    if original:
        trade_id = original["id"]
        conn.execute(
            f"UPDATE fx_trades SET {','.join(k + '=?' for k in fields)},version=version+1,editing=0 WHERE id=?",
            (*fields.values(), trade_id),
        )
    else:
        fields.update(
            version=1,
            legacy_txn=legacy and legacy["transaction_id"],
            backup=backup,
            preview_hash=preview_hash,
        )
        trade_id = conn.execute(
            f"INSERT INTO fx_trades({','.join(fields)}) VALUES({','.join('?' for _ in fields)})",
            tuple(fields.values()),
        ).lastrowid
    positions(conn, date.max)  # Recheck every subsequent sale after a backdated change.
    return trade_id


def save(conn, command, trade_id=None):
    with _account_write(conn):
        payload = f"{trade_id}/{command.model_dump_json()}"
        receipt = conn.execute(
            "SELECT * FROM fx_requests WHERE request_id=?", (str(command.request_id),)
        ).fetchone()
        if receipt:
            if receipt["payload"] != payload:
                raise DomainConflictError("이미 다른 환전에 사용한 요청 번호입니다")
            return {"id": receipt["trade_id"]}
        original = None
        if trade_id is not None:
            original = conn.execute(
                "SELECT * FROM fx_trades WHERE id=?", (trade_id,)
            ).fetchone()
            if not original:
                raise DomainNotFoundError("환전 기록이 없습니다")
            if original["legacy_txn"]:
                raise DomainConflictError(
                    "이관을 확정한 환전은 원본 행과 함께 보존합니다"
                )
        if command.expected_version != (original["version"] if original else 0):
            raise DomainConflictError("환전이 변경되었습니다. 다시 조회하세요")
        saved = write_trade(conn, command.trade, original=original)
        conn.execute(
            "INSERT INTO fx_requests VALUES (?,?,?)",
            (str(command.request_id), payload, saved),
        )
        return {"id": saved}


@dataclass
class Position:
    minor: int = 0
    cost: int = 0
    realized: int = 0
    fees: int = 0


def positions(conn, day):
    result = defaultdict(Position)
    for row in conn.execute(
        "SELECT currency,side,minor,principal,fee FROM fx_trades WHERE day<=? ORDER BY day,id",
        (day.isoformat(),),
    ):
        pos = result[row["currency"]]
        qty = row["minor"]
        if row["side"] == "buy":
            pos.minor += qty
            pos.cost += row["principal"]
        else:
            if qty > pos.minor:
                raise DomainConflictError(
                    f"{row['currency']} 매도 수량이 거래일의 보유 수량을 초과합니다"
                )
            basis = round_won(Fraction(pos.cost * qty, pos.minor))
            pos.minor -= qty
            pos.cost -= basis
            pos.realized += row["principal"] - basis
        pos.fees += row["fee"]
    return result


def set_quote(conn, body):
    with _account_write(conn):
        conn.execute(
            """INSERT INTO fx_quotes(currency,rate_date,rate,source) VALUES(?,?,?,?)
            ON CONFLICT(currency,rate_date) DO UPDATE SET rate=excluded.rate,source=excluded.source""",
            (body.currency, body.rate_date.isoformat(), body.rate, body.source),
        )
    return {"saved": True}


def report(conn, day):
    quotes = {
        r["currency"]: dict(r)
        for r in conn.execute(
            "SELECT * FROM fx_quotes WHERE rate_date=?", (day.isoformat(),)
        )
    }
    positions_by_currency = positions(conn, day)
    holdings = {
        r["account_id"]: r["currency"]
        for r in conn.execute("SELECT * FROM fx_accounts WHERE role='holding'")
    }
    rows = conn.execute(
        """SELECT a.id,a.name,p.currency,SUM(p.amount) minor FROM postings p
        JOIN accounts a ON a.id=p.account_id JOIN transactions t ON t.id=p.txn_id
        WHERE t.posted=1 AND t.scenario_id=1 AND t.date<=? AND a.type IN ('asset','liability')
        AND p.currency<>'KRW' GROUP BY a.id,p.currency ORDER BY a.id,p.currency""",
        (day.isoformat(),),
    )
    subtotal = 0
    missing = 0
    balances = []
    for row in rows:
        currency, qty = row["currency"], row["minor"]
        managed = holdings.get(row["id"]) == currency
        pos = positions_by_currency.get(currency) if managed else None
        quote = quotes.get(currency)
        value = None
        if qty == 0:
            value = 0
        elif quote and currency in MINOR_UNITS:
            raw = Fraction(abs(qty), 10 ** MINOR_UNITS[currency]) * Fraction(
                quote["rate"]
            )
            value = round_won(raw) * (1 if qty >= 0 else -1)
        if value is None:
            missing += 1
        else:
            subtotal += value
        known_cost = pos is not None and pos.minor == qty
        balances.append(
            dict(
                account_id=row["id"],
                name=row["name"],
                currency=currency,
                minor=str(qty),
                value=None if value is None else str(value),
                cost=str(pos.cost) if known_cost else None,
                unrealized=str(value - pos.cost)
                if known_cost and value is not None
                else None,
                realized=str(pos.realized) if pos else None,
                fees=str(pos.fees) if pos else None,
            )
        )
    krw = sum(
        r[0]
        for r in conn.execute(
            f"""SELECT p.amount FROM transactions t JOIN postings p ON p.txn_id=t.id
        JOIN accounts a ON a.id=p.account_id WHERE t.posted=1 AND t.scenario_id=1 AND t.date<=?
        AND a.type IN ('asset','liability') AND {KRW_TRANSACTION}""",
            (day.isoformat(),),
        )
    )
    trades = []
    for row in conn.execute(
        """SELECT f.*,v.source_row,v.source_hash,v.source_file FROM fx_trades f
        LEFT JOIN transaction_import_provenance v ON f.legacy_txn=v.txn_id WHERE f.day<=? ORDER BY day DESC,id DESC""",
        (day.isoformat(),),
    ):
        trade = dict(row)
        for key in ("minor", "cash", "fee", "principal"):
            trade[key] = str(trade[key])
        trades.append(trade)
    return dict(
        balances=balances,
        quotes=quotes,
        trades=trades,
        foreign_subtotal=str(subtotal),
        krw=str(krw),
        valued_net=str(krw + subtotal),
        missing=missing,
    )
