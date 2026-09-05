"""Assemble input responses without depending on SQLite or HTTP."""
from moneymap.domain.ports import TransactionInputQueries
from moneymap.domain.transaction_input import LastPair, RecentInput, normalize_item_key, validate_latest_pair


def last_pair(queries: TransactionInputQueries, item: str) -> LastPair:
    key = normalize_item_key(item)
    return validate_latest_pair(key, queries.last_candidate(key) if key else None)


def recent_inputs(queries: TransactionInputQueries, limit: int) -> list[RecentInput]:
    return queries.recent(limit)
