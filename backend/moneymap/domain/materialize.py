"""반복 규칙 materialize — 계획 수립(순수)과 적용(어댑터)의 분리.

    plan_materialization(rules, today)   ← 순수 함수: 뭘 만들지 계산만
         │  MaterializationPlan { 생성할 거래들, 규칙별 새 watermark }
         ▼
    어댑터.apply_materialization(plan)   ← 단일 SQL 트랜잭션으로 적용

원자성 (D9): 거래 생성과 last_materialized 갱신이 한 트랜잭션 —
도중에 죽으면 전부 롤백되고, 다음 실행이 같은 계획을 다시 세운다.
이중 기입은 구조적으로 불가능하다.

과거 불변 (D9): 이 모듈은 기존 거래를 절대 건드리지 않는다. 규칙
수정은 다음 plan부터만 반영된다.
"""

from __future__ import annotations

import datetime

from pydantic import BaseModel

from moneymap.domain.money import Money
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.transaction import Posting, Transaction


class MaterializationPlan(BaseModel):
    transactions: list[Transaction]
    # rule_id → 새 last_materialized (실행이 없어도 watermark는 전진)
    watermarks: dict[int, datetime.date]
    # rule_id → 계획 수립 시점의 last_materialized (동시 실행 감지용 낙관적 잠금)
    expected: dict[int, datetime.date | None] = {}

    @property
    def is_empty(self) -> bool:
        return not self.transactions and not self.watermarks


def rule_to_transaction(rule: RecurringRule, date: datetime.date) -> Transaction:
    """규칙 1회 실행 → 2-leg 거래. to가 차변(+), from이 대변(−)."""
    assert rule.id is not None, "저장된 규칙만 materialize할 수 있습니다"
    return Transaction(
        scenario_id=rule.scenario_id,
        date=date,
        description=rule.description,
        source_rule_id=rule.id,
        postings=[
            Posting(account_id=rule.to_account_id, amount=rule.amount),
            Posting(
                account_id=rule.from_account_id,
                amount=Money(amount=-rule.amount.amount, currency=rule.amount.currency),
            ),
        ],
    )


def plan_materialization(
    rules: list[RecurringRule], today: datetime.date
) -> MaterializationPlan:
    """오늘까지의 미실행분을 계산한다 (오늘 포함).

    규칙별 window = [max(start_date, last_materialized+1), min(today, end_date)]
    """
    txns: list[Transaction] = []
    watermarks: dict[int, datetime.date] = {}
    expected: dict[int, datetime.date | None] = {}

    for rule in rules:
        assert rule.id is not None
        window_start = rule.start_date
        if rule.last_materialized is not None:
            window_start = max(
                window_start, rule.last_materialized + datetime.timedelta(days=1)
            )
        window_end = today if rule.end_date is None else min(today, rule.end_date)
        if window_end < window_start:
            continue  # 이미 최신이거나 아직 시작 전

        for occ in rule.schedule.occurrences(window_start, window_end):
            txns.append(rule_to_transaction(rule, occ))
        # 실행이 없어도 watermark는 window_end까지 전진 — 다음 계획이 같은
        # 구간을 다시 훑지 않게 한다.
        watermarks[rule.id] = window_end
        expected[rule.id] = rule.last_materialized

    txns.sort(key=lambda t: t.date)
    return MaterializationPlan(transactions=txns, watermarks=watermarks, expected=expected)
