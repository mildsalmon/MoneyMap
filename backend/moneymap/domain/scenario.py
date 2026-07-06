"""Scenario — What-if 가설 장부.

    actual (id=1, base=None, fork_date=None)   ← 실제 장부, init 시 시드
      ├── 시나리오 A (base=1, fork_date=...)
      └── 시나리오 B (base=1, fork_date=...)

v1 제한 (D2): base는 항상 actual — 시나리오 위에 시나리오를 쌓는 중첩은
스키마로는 표현 가능하지만 v1 코드에서 거부한다. 해제는 v2 (TODOS.md).
fork_date는 사용자가 선택 가능 — 기본 오늘, 과거 허용 (D7-B).
과거 fork 시: actual 거래는 fork_date '이전'(exclusive)만 포함되고,
반복 규칙은 생성 시점의 현재 상태로 복사된다 (copy-on-fork, D5).
"""

from __future__ import annotations

import datetime

from pydantic import BaseModel, Field, model_validator

from moneymap.domain.errors import InvalidScenarioBaseError

ACTUAL_SCENARIO_ID = 1


class Scenario(BaseModel):
    id: int | None = None
    name: str = Field(min_length=1)
    base_scenario_id: int | None = None  # None = actual 자신
    fork_date: datetime.date | None = None
    created_at: datetime.datetime | None = None

    @model_validator(mode="after")
    def _enforce_v1_shape(self) -> "Scenario":
        if self.base_scenario_id is None:
            # actual 시나리오: fork_date도 없어야 한다
            if self.fork_date is not None:
                raise InvalidScenarioBaseError(
                    "actual 시나리오는 fork_date를 가질 수 없습니다"
                )
        else:
            if self.base_scenario_id != ACTUAL_SCENARIO_ID:
                raise InvalidScenarioBaseError(
                    "v1에서는 actual에서만 시나리오를 만들 수 있습니다 (중첩은 v2)"
                )
            if self.fork_date is None:
                raise InvalidScenarioBaseError("시나리오는 fork_date가 필요합니다")
        return self

    @property
    def is_actual(self) -> bool:
        return self.base_scenario_id is None
