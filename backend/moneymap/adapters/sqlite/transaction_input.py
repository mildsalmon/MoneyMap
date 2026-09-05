"""Bounded input reads. The request owns the coherent SQLite read snapshot."""
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID
from moneymap.domain.transaction_input import CandidateLeg, PairCandidate, RecentInput


class SqliteTransactionInputQueries:
    def __init__(self, conn):
        self.conn = conn

    def last_candidate(self, item_key: str) -> PairCandidate | None:
        # LIMIT the eligible history FIRST. Postings/account validity must not
        # enter this WHERE, or we would resurrect an older valid combination.
        candidate = self.conn.execute(
            "SELECT id,entry_origin FROM transactions "
            "WHERE scenario_id=? AND item_key=? AND posted=1 "
            "AND entry_origin IN ('user','legacy_unknown') ORDER BY id DESC LIMIT 1",
            (ACTUAL_SCENARIO_ID, item_key),
        ).fetchone()
        if candidate is None:
            return None
        rows = self.conn.execute(
            "SELECT p.account_id,p.amount,p.currency, "
            "(a.id IS NOT NULL AND a.archived=0 AND a.is_placeholder=0 AND a.is_system=0 "
            "AND NOT EXISTS(SELECT 1 FROM accounts child WHERE child.parent_id=a.id)) AS available "
            "FROM postings p LEFT JOIN accounts a ON a.id=p.account_id "
            "WHERE p.txn_id=? ORDER BY p.id LIMIT 3",
            (candidate["id"],),
        ).fetchall()
        return PairCandidate(candidate["id"], candidate["entry_origin"], tuple(CandidateLeg(**dict(r)) for r in rows))

    def recent(self, limit: int) -> list[RecentInput]:
        recent = self.conn.execute(
            "SELECT id,date,description FROM transactions "
            "WHERE scenario_id=? AND posted=1 AND entry_origin IN ('user','legacy_unknown') "
            "ORDER BY id DESC LIMIT ?",
            (ACTUAL_SCENARIO_ID, limit),
        ).fetchall()
        if not recent:
            return []
        # One batched aggregation, only for the bounded candidate IDs. Keeping
        # candidate order in Python avoids a temporary recency sort in SQLite.
        placeholders = ",".join("?" for _ in recent)
        rows = self.conn.execute(
            "SELECT txn_id,COUNT(id) AS posting_count, "
            "SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS amount, "
            "CASE WHEN COUNT(id)=2 THEN MAX(CASE WHEN amount>0 THEN account_id END) END AS debit_account_id, "
            "CASE WHEN COUNT(id)=2 THEN MAX(CASE WHEN amount<0 THEN account_id END) END AS credit_account_id "
            f"FROM postings WHERE txn_id IN ({placeholders}) GROUP BY txn_id",
            tuple(row["id"] for row in recent),
        ).fetchall()
        summaries = {row["txn_id"]: dict(row) for row in rows}
        result = []
        for row in recent:
            summary = summaries.get(row["id"], {"posting_count": 0, "amount": 0,
                                                "debit_account_id": None, "credit_account_id": None})
            result.append(RecentInput(**dict(row), **{k: v for k, v in summary.items() if k != "txn_id"}))
        return result
