"""What-if 시뮬레이션 — 순수 계산. DB에 아무것도 쓰지 않는다.

순자산(net worth) = 자산·부채 계정 잔액의 합. 거래가 순자산을 바꾸는
경우는 자산/부채 레그와 수익/비용/자본 레그가 만날 때뿐이다:

    수익 → 자산   (월급)      순자산 +
    자산 → 비용   (월세)      순자산 −
    자산 → 자산   (적금 이체)  변화 없음
    자산 → 부채   (카드값 납부) 변화 없음 (자산↓ 부채↑상쇄)

미래 기준선 "현재 패턴 유지" (D17, cross-model 합의):
    반복 규칙 + 최근 3개월 변동지출(규칙이 만들지 않은 지출) 월평균.
    규칙만 반영하면 식비 같은 비정기 지출이 0으로 계산돼 곡선이
    체계적으로 낙관 편향된다 — 그걸 막는 정의다.
"""

from __future__ import annotations

import calendar
import datetime

from moneymap.domain.account import AccountType
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.transaction import Transaction

_NET_WORTH_TYPES = {AccountType.ASSET, AccountType.LIABILITY}


def net_worth_delta(
    txn: Transaction, account_types: dict[int, AccountType]
) -> int:
    """거래 하나가 순자산에 주는 변화 (자산·부채 레그의 합)."""
    return sum(
        p.amount.amount
        for p in txn.postings
        if account_types[p.account_id] in _NET_WORTH_TYPES
    )


def rule_delta_per_occurrence(
    rule: RecurringRule, account_types: dict[int, AccountType]
) -> int:
    """규칙 1회 실행이 순자산에 주는 변화."""
    delta = 0
    if account_types[rule.to_account_id] in _NET_WORTH_TYPES:
        delta += rule.amount.amount  # 차변(+)
    if account_types[rule.from_account_id] in _NET_WORTH_TYPES:
        delta -= rule.amount.amount  # 대변(−)
    return delta


def variable_monthly_spend(
    transactions: list[Transaction],
    account_types: dict[int, AccountType],
    window_end: datetime.date,
    window_months: int = 3,
) -> int:
    """최근 N개월 변동지출 월평균 — 규칙이 만들지 않은(수동 입력) 지출만.

    기록이 N개월 미만이어도 N으로 나눈다 대신 실제 있는 개월수로 나누는 건
    시작 직후 과대 추정 위험이 있어, 보수적으로 min(N, 기록 개월수)를 쓴다.
    기록이 전혀 없으면 0.
    """
    window_start = window_end - datetime.timedelta(days=window_months * 30)
    spend = 0
    earliest: datetime.date | None = None
    for txn in transactions:
        if txn.date > window_end:
            continue
        if earliest is None or txn.date < earliest:
            earliest = txn.date
        if txn.date < window_start or txn.source_rule_id is not None:
            continue
        spend += sum(
            p.amount.amount
            for p in txn.postings
            if account_types[p.account_id] == AccountType.EXPENSE
        )
    if spend == 0 or earliest is None:
        return 0
    recorded_months = max(1, min(window_months, ((window_end - earliest).days // 30) or 1))
    return spend // recorded_months


def _month_ends(start: datetime.date, end: datetime.date) -> list[datetime.date]:
    out = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        d = datetime.date(y, m, calendar.monthrange(y, m)[1])
        if start <= d <= end:
            out.append(d)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def project_net_worth(
    *,
    start_net_worth: int,
    start: datetime.date,
    end: datetime.date,
    rules: list[RecurringRule],
    account_types: dict[int, AccountType],
    monthly_variable_spend: int = 0,
    transactions: list[Transaction] | None = None,
) -> list[tuple[datetime.date, int]]:
    """[start, end] 구간의 순자산 곡선 — 일 단위 fold, 단일 패스.

    반환: 변화가 있는 날짜의 (날짜, 그날 종가 순자산) 목록.
    시작점 (start, start_net_worth)은 항상 포함된다.
    변동지출은 매월 말일에 일괄 차감하는 가상 규칙으로 취급한다.
    transactions: 구간 안의 확정 거래(시나리오의 수동 입력분 등)도 곡선에 합산.
    """
    deltas: dict[datetime.date, int] = {}

    for t in transactions or []:
        if start <= t.date <= end:
            d = net_worth_delta(t, account_types)
            if d:
                deltas[t.date] = deltas.get(t.date, 0) + d

    for rule in rules:
        per_occ = rule_delta_per_occurrence(rule, account_types)
        if per_occ == 0:
            continue
        rule_end = end if rule.end_date is None else min(end, rule.end_date)
        rule_start = max(start, rule.start_date)
        for occ in rule.schedule.occurrences(rule_start, rule_end):
            deltas[occ] = deltas.get(occ, 0) + per_occ

    if monthly_variable_spend:
        for month_end in _month_ends(start, end):
            deltas[month_end] = deltas.get(month_end, 0) - monthly_variable_spend

    net = start_net_worth + deltas.pop(start, 0)  # 시작일 당일 실행분은 시작점에 흡수
    curve = [(start, net)]
    for day in sorted(deltas):
        net += deltas[day]
        curve.append((day, net))
    return curve
