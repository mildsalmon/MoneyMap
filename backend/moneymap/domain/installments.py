"""Finite principal schedules. Interest/fees must be separate expense components."""

from __future__ import annotations

import datetime as dt
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .projection import add_months

Amount = Annotated[int, Field(strict=True, ge=1, le=9_007_199_254_740_991)]
Id = Annotated[int, Field(strict=True, ge=1)]


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    expected_revision: Id


class Purchase(Command):
    description: str = Field(min_length=1, max_length=2000)
    date: dt.date
    debit_account_id: Id
    card_account_id: Id
    cash_account_id: Id
    principal: Amount
    exclude_from_spend: bool = False
    months: int = Field(strict=True, ge=2, le=60)
    first_due_date: dt.date

    @model_validator(mode="after")
    def dates_and_amount(self):
        if self.first_due_date < self.date:
            raise ValueError("첫 납부일은 구매일 이후여야 합니다")
        if self.principal < self.months:
            raise ValueError("회차마다 원금이 1원 이상이어야 합니다")
        if not self.description.strip():
            raise ValueError("구매 내역을 입력하세요")
        if self.first_due_date.year > 9994:
            raise ValueError("납부일이 허용 범위를 넘습니다")
        return self


def schedule(principal: int, months: int, first: dt.date) -> list[dict]:
    """Anchor every month to the original day, with integer remainder at the end."""
    each, remainder = divmod(principal, months)
    return [
        {
            "number": i + 1,
            "due_date": add_months(first, i).isoformat(),
            "principal": each + (remainder if i == months - 1 else 0),
        }
        for i in range(months)
    ]


class Allocation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    installment_id: Id
    amount: Amount


class Allocate(Command):
    transaction_id: Id
    kind: Literal["payment", "refund"] = "payment"
    allocations: list[Allocation] = Field(max_length=120)

    @model_validator(mode="after")
    def unique_rows(self):
        ids = [row.installment_id for row in self.allocations]
        if len(ids) != len(set(ids)):
            raise ValueError("같은 회차는 한 번만 배분하세요")
        return self


class UpdatePlan(Command):
    projection_mode: Literal["separate", "included", "pending"]
    # Exact rule content shown to the user; changed rules require a new decision.
    rule_signature: str = Field(max_length=64)


class Reschedule(Command):
    due_date: dt.date
