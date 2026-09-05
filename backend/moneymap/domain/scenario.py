"""Scenario identity and lifecycle invariants; actual is a protected system row."""

from __future__ import annotations

import datetime

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from moneymap.domain.errors import DomainConflictError, DomainError

from moneymap.domain.errors import InvalidScenarioBaseError

ACTUAL_SCENARIO_ID = 1


class Scenario(BaseModel):
    id: int | None = None
    name: str = Field(min_length=1)
    base_scenario_id: int | None = None  # None = actual 자신
    fork_date: datetime.date | None = None
    created_at: datetime.datetime | None = None
    description: str = ""
    status: Literal["active", "archived"] = "active"
    archived_at: datetime.datetime | None = None
    version: int = Field(default=1, gt=0)
    rule_mode: Literal["live_additive", "legacy_snapshot"] = "live_additive"

    def protect_actual(self) -> None:
        if self.is_actual or self.id == ACTUAL_SCENARIO_ID:
            raise DomainError(
                "실제 장부는 변경할 수 없습니다", code="actual_scenario_protected"
            )

    def require_active(self, *, assumptions: bool = False) -> None:
        self.protect_actual()
        if self.status == "archived":
            raise DomainConflictError(
                "보관된 시나리오는 읽기 전용입니다", code="scenario_archived_read_only"
            )
        if assumptions and self.rule_mode == "legacy_snapshot":
            raise DomainConflictError(
                "기존 가정을 먼저 분류하세요", code="legacy_rule_resolution_required"
            )

    def require_version(
        self, version: int, *, code: str = "scenario_version_conflict"
    ) -> None:
        if self.version != version:
            raise DomainConflictError(
                "다른 변경이 있습니다. 최신 내용을 확인하세요",
                code=code,
                context={"current_version": self.version},
            )

    def renamed(self, name: str, description: str) -> "Scenario":
        self.require_active()
        return Scenario.model_validate(
            {
                **self.model_dump(),
                "name": name,
                "description": description,
                "version": self.version + 1,
            }
        )

    def transitioned(
        self, status: Literal["active", "archived"], now: datetime.datetime
    ) -> "Scenario":
        self.protect_actual()
        if self.status == status:
            return self
        return self.model_copy(
            update={
                "status": status,
                "archived_at": now if status == "archived" else None,
                "version": self.version + 1,
            }
        )

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
