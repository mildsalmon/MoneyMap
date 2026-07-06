import datetime

import pytest
from pydantic import ValidationError

from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    MixedCurrencyError,
    Money,
    Posting,
    Transaction,
    UnbalancedTransactionError,
)

TODAY = datetime.date(2026, 7, 5)


def txn(postings: list[Posting]) -> Transaction:
    return Transaction(
        scenario_id=ACTUAL_SCENARIO_ID, date=TODAY, description="t", postings=postings
    )


def test_balanced_transaction_accepted():
    t = txn(
        [
            Posting(account_id=1, amount=Money(amount=52_000)),
            Posting(account_id=2, amount=Money(amount=-52_000)),
        ]
    )
    assert sum(p.amount.amount for p in t.postings) == 0


def test_unbalanced_rejected():
    with pytest.raises((UnbalancedTransactionError, ValidationError)):
        txn(
            [
                Posting(account_id=1, amount=Money(amount=52_000)),
                Posting(account_id=2, amount=Money(amount=-50_000)),
            ]
        )


def test_mixed_currency_rejected():
    with pytest.raises((MixedCurrencyError, ValidationError)):
        txn(
            [
                Posting(account_id=1, amount=Money(amount=100, currency="USD")),
                Posting(account_id=2, amount=Money(amount=-100, currency="KRW")),
            ]
        )


def test_zero_posting_rejected():
    with pytest.raises(ValidationError):
        Posting(account_id=1, amount=Money(amount=0))


def test_single_posting_rejected():
    with pytest.raises(ValidationError):
        txn([Posting(account_id=1, amount=Money(amount=0))])


def test_n_leg_transaction_accepted():
    # 월급 300만 = Toss 270만 입금 + 세금 30만 (N-leg도 합이 0이면 유효)
    t = txn(
        [
            Posting(account_id=10, amount=Money(amount=2_700_000)),
            Posting(account_id=11, amount=Money(amount=300_000)),
            Posting(account_id=12, amount=Money(amount=-3_000_000)),
        ]
    )
    assert len(t.postings) == 3
