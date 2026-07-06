import datetime

import pytest
from pydantic import ValidationError

from moneymap.domain import ACTUAL_SCENARIO_ID, Money, RecurringRule, Schedule

TODAY = datetime.date(2026, 7, 5)


def rule(**overrides) -> RecurringRule:
    base = dict(
        scenario_id=ACTUAL_SCENARIO_ID,
        description="월세",
        from_account_id=1,
        to_account_id=2,
        amount=Money(amount=800_000),
        schedule=Schedule(spec="monthly:1"),
        start_date=TODAY,
    )
    base.update(overrides)
    return RecurringRule(**base)


def test_valid_rule():
    r = rule()
    assert r.end_date is None  # 무한 반복


def test_negative_amount_rejected():
    with pytest.raises(ValidationError):
        rule(amount=Money(amount=-1000))


def test_zero_amount_rejected():
    with pytest.raises(ValidationError):
        rule(amount=Money(amount=0))


def test_same_from_to_rejected():
    with pytest.raises(ValidationError):
        rule(to_account_id=1)


def test_end_before_start_rejected():
    with pytest.raises(ValidationError):
        rule(end_date=TODAY - datetime.timedelta(days=1))


def test_end_equal_start_ok():
    rule(end_date=TODAY)
