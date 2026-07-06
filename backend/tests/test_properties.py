"""속성 기반 테스트 (hypothesis) — 회계 invariant의 수학적 성질 검증 (D10).

무작위 입력 수백 세트로 다음을 보장한다:
  1. 합이 0인 posting 집합은 항상 수용되고, 장부 전체 합도 항상 0
  2. 합이 0이 아닌 posting 집합은 예외 없이 전부 거부
  3. monthly 일정의 모든 실행일은 '당김' 규칙을 정확히 따른다
"""

import calendar
import datetime

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError

from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Money,
    Posting,
    Schedule,
    Transaction,
    UnbalancedTransactionError,
)

TODAY = datetime.date(2026, 7, 5)

nonzero_amounts = st.integers(min_value=-10_000_000, max_value=10_000_000).filter(
    lambda n: n != 0
)


@given(st.lists(nonzero_amounts, min_size=1, max_size=8))
def test_balanced_transactions_always_accepted(amounts: list[int]):
    """임의의 금액 목록 + 상쇄 posting 하나 = 항상 유효한 거래."""
    total = sum(amounts)
    if total == 0:
        amounts = amounts + [1, -1]
        total = 0
    postings = [
        Posting(account_id=i + 1, amount=Money(amount=a))
        for i, a in enumerate(amounts)
    ]
    if total != 0:
        postings.append(Posting(account_id=99, amount=Money(amount=-total)))

    txn = Transaction(
        scenario_id=ACTUAL_SCENARIO_ID, date=TODAY, postings=postings
    )
    assert sum(p.amount.amount for p in txn.postings) == 0


@given(st.lists(nonzero_amounts, min_size=2, max_size=8))
def test_unbalanced_transactions_always_rejected(amounts: list[int]):
    """합이 0이 아닌 posting 집합은 단 하나도 통과하면 안 된다."""
    if sum(amounts) == 0:
        amounts[0] += 1
        if amounts[0] == 0:
            amounts[0] = 1
    if sum(amounts) == 0:  # 여전히 0이면 이 케이스는 건너뜀
        return
    postings = [
        Posting(account_id=i + 1, amount=Money(amount=a))
        for i, a in enumerate(amounts)
    ]
    with pytest.raises((UnbalancedTransactionError, ValidationError)):
        Transaction(scenario_id=ACTUAL_SCENARIO_ID, date=TODAY, postings=postings)


@given(
    day=st.integers(min_value=1, max_value=31),
    start_year=st.integers(min_value=2024, max_value=2030),
    start_month=st.integers(min_value=1, max_value=12),
    months=st.integers(min_value=1, max_value=24),
)
def test_monthly_occurrences_respect_clamping(
    day: int, start_year: int, start_month: int, months: int
):
    """monthly:N의 모든 실행일 = min(N, 그 달의 마지막 날), 월당 정확히 1회."""
    start = datetime.date(start_year, start_month, 1)
    end_year, end_month = start_year, start_month + months - 1
    end_year += (end_month - 1) // 12
    end_month = (end_month - 1) % 12 + 1
    end = datetime.date(end_year, end_month, calendar.monthrange(end_year, end_month)[1])

    occ = list(Schedule(spec=f"monthly:{day}").occurrences(start, end))

    assert len(occ) == months  # 구간의 매달 정확히 1회 (건너뛰기 버그 없음)
    assert occ == sorted(occ)
    for d in occ:
        last = calendar.monthrange(d.year, d.month)[1]
        assert d.day == min(day, last)  # 말일 당김 규칙
