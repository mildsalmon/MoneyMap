"""Bounded actual-ledger reads inside the request's existing read snapshot."""
from __future__ import annotations

import datetime
import sqlite3

from moneymap.domain import ACTUAL_SCENARIO_ID, Money, Posting, Transaction

PAGE_SIZE = 100


class SqliteTransactionHistory:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def page(self, start: datetime.date, end: datetime.date, tag: str, page: int) -> dict:
        where = "t.scenario_id=? AND t.posted=1 AND t.date>=? AND t.date<=?"
        params: list[object] = [ACTUAL_SCENARIO_ID, start.isoformat(), end.isoformat()]
        if tag:
            # Drive the tag filter from matching IDs, not a per-row name lookup.
            where += (
                " AND t.id IN (SELECT tt.txn_id FROM tags g "
                "JOIN transaction_tags tt ON tt.tag_id=g.id WHERE g.name=?)"
            )
            params.append(tag)
        total = self.conn.execute(
            f"SELECT COUNT(*) FROM transactions t WHERE {where}", params
        ).fetchone()[0]
        total_pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(page, total_pages)
        result = dict(items=[], total=total, page=page, page_size=PAGE_SIZE, total_pages=total_pages)
        if not total:
            return result
        rows = self.conn.execute(
            f"SELECT t.* FROM transactions t WHERE {where} "
            "ORDER BY t.date DESC,t.id DESC LIMIT ? OFFSET ?",
            [*params, PAGE_SIZE, (page - 1) * PAGE_SIZE],
        ).fetchall()
        # Limit transaction IDs FIRST; only these rows' postings/tags are hydrated.
        ids = [row["id"] for row in rows]
        placeholders = ",".join("?" for _ in ids)
        postings: dict[int, list[Posting]] = {tid: [] for tid in ids}
        tags: dict[int, list[str]] = {tid: [] for tid in ids}
        for row in self.conn.execute(
            f"SELECT txn_id,account_id,amount,currency FROM postings WHERE txn_id IN ({placeholders}) ORDER BY id", ids
        ):
            postings[row["txn_id"]].append(Posting(
                account_id=row["account_id"], amount=Money(amount=row["amount"], currency=row["currency"]),
                legacy_zero=row["amount"] == 0,
            ))
        for row in self.conn.execute(
            "SELECT tt.txn_id,g.name FROM transaction_tags tt JOIN tags g ON g.id=tt.tag_id "
            f"WHERE tt.txn_id IN ({placeholders}) ORDER BY g.name_key", ids
        ):
            tags[row["txn_id"]].append(row["name"])
        result["items"] = [Transaction(
            id=row["id"], scenario_id=row["scenario_id"], date=row["date"],
            description=row["description"], memo=row["memo"], source_rule_id=row["source_rule_id"],
            postings=postings[row["id"]], tags=tags[row["id"]],
        ).model_dump(mode="json") for row in rows]
        return result
