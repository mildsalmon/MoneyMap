"""RecurringRule — 반복 거래 규칙 (v1: 2-leg transfer만).

    "매월 25일, 월급 300만이 급여(수익)에서 Toss(자산)로"
      from_account → to_account, amount는 양수 Money.

materialize 시 만들어지는 거래 (from에서 나가서 to로 들어감):
      to_account   +amount  (차변)
      from_account −amount  (대변)

새 시나리오는 실제 규칙을 실시간 상속하며 전용 규칙만 별도로 소유한다.
materialize 의미론(원자성·과거 불변)은 services 쪽 책임 (D9).
"""

from __future__ import annotations

import datetime

from pydantic import BaseModel, model_validator

from moneymap.domain.money import Money
from moneymap.domain.schedule import Schedule


class RecurringRule(BaseModel):
    id: int | None = None
    scenario_id: int
    description: str = ""
    from_account_id: int
    to_account_id: int
    amount: Money
    schedule: Schedule
    start_date: datetime.date
    end_date: datetime.date | None = None  # None = 무한
    last_materialized: datetime.date | None = None

    @model_validator(mode="after")
    def _enforce_invariants(self) -> "RecurringRule":
        if self.amount.amount <= 0:
            raise ValueError("반복 규칙의 금액은 양수여야 합니다 (방향은 from→to)")
        if self.from_account_id == self.to_account_id:
            raise ValueError("from 계정과 to 계정이 같을 수 없습니다")
        if self.end_date is not None and self.end_date < self.start_date:
            raise ValueError("end_date는 start_date보다 빠를 수 없습니다")
        return self
