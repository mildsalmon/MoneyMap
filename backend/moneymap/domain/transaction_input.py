"""Exact item identity and validation of the *latest* ledger candidate.

Selection happens in the query port before validation: an invalid latest entry
must never silently fall back to an older, valid account combination.
"""
from dataclasses import dataclass
from typing import Literal
import unicodedata

from pydantic import BaseModel


# Explicit union of ECMAScript trim and Python whitespace. Keep the frontend
# itemKey equivalent, including pasted BOM (FEFF), NEL and C0 separators.
V4_ITEM_WHITESPACE = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def normalize_item_key_v4(item: str) -> str:
    """Frozen schema-v4 identity used by both migration replay and live writes."""
    return unicodedata.normalize("NFC", item).strip(V4_ITEM_WHITESPACE)


normalize_item_key = normalize_item_key_v4


@dataclass(frozen=True)
class CandidateLeg:
    account_id: int
    amount: int
    currency: str
    available: bool


@dataclass(frozen=True)
class PairCandidate:
    transaction_id: int
    origin: str
    legs: tuple[CandidateLeg, ...]


class LastPair(BaseModel):
    item_key: str
    status: Literal["matched", "none", "unavailable", "legacy_confirmation_required"]
    source_transaction_id: int | None = None
    debit_account_id: int | None = None
    credit_account_id: int | None = None
    unavailable_reason: Literal["split", "invalid_pair", "account_unavailable"] | None = None


class RecentInput(BaseModel):
    id: int
    date: str
    description: str
    amount: int
    posting_count: int
    debit_account_id: int | None
    credit_account_id: int | None


def validate_latest_pair(item_key: str, candidate: PairCandidate | None) -> LastPair:
    if candidate is None:
        return LastPair(item_key=item_key, status="none")
    result = LastPair(item_key=item_key, status="unavailable", source_transaction_id=candidate.transaction_id)
    if len(candidate.legs) != 2:
        return result.model_copy(update={"unavailable_reason": "split"})
    a, b = candidate.legs
    if a.account_id == b.account_id or a.amount == 0 or a.amount + b.amount != 0 or a.currency != b.currency:
        return result.model_copy(update={"unavailable_reason": "invalid_pair"})
    if not all(leg.available for leg in candidate.legs):
        return result.model_copy(update={"unavailable_reason": "account_unavailable"})
    debit, credit = (a, b) if a.amount > 0 else (b, a)
    return result.model_copy(update={
        "status": "legacy_confirmation_required" if candidate.origin == "legacy_unknown" else "matched",
        "debit_account_id": debit.account_id,
        "credit_account_id": credit.account_id,
    })
