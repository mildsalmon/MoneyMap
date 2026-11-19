"""Finite principal schedules and statement-confirmed charges."""

from __future__ import annotations

import datetime as dt
from typing import Annotated, Literal
from uuid import UUID
from collections import Counter

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .errors import DomainValidationError
from .projection import add_months

Amount = Annotated[int, Field(strict=True, ge=1, le=9_007_199_254_740_991)]
Id = Annotated[int, Field(strict=True, ge=1)]


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    expected_revision: Id


Nonnegative = Annotated[int, Field(strict=True, ge=0, le=9_007_199_254_740_991)]


class Costs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interest: Nonnegative | None
    fee: Nonnegative | None


class StatementRow(Costs):
    principal: Amount


class StatementUpdate(Command, Costs):
    effective_date: dt.date
    early_fee: Nonnegative = 0
    cancelled_interest: Nonnegative = 0

    @model_validator(mode="after")
    def check_cancellation(self):
        if self.cancelled_interest > (self.interest or 0):
            raise ValueError("취소 이자가 명세서 이자를 넘습니다")
        return self


class Purchase(Command):
    description: str = Field(min_length=1, max_length=2000)
    date: dt.date
    debit_account_id: Id
    card_account_id: Id
    cash_account_id: Id
    principal: Amount
    statement_date: dt.date | None = None
    statement: list[StatementRow] | None = Field(default=None, max_length=60)
    interest_account_id: Id | None = None
    fee_account_id: Id | None = None
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
        if self.statement is not None:
            if self.statement_date is not None and self.statement_date < self.date:
                raise ValueError("명세서 기준일은 구매일 이후여야 합니다")
            if (
                len(self.statement) != self.months
                or sum(row.principal for row in self.statement) != self.principal
            ):
                raise ValueError("명세서 회차 수와 원금 합계를 확인하세요")
            if (
                not self.interest_account_id
                or not self.fee_account_id
                or self.interest_account_id == self.fee_account_id
            ):
                raise ValueError("이자와 수수료에 각각 사용할 비용 계정을 선택하세요")
        elif self.interest_account_id or self.fee_account_id or self.statement_date:
            raise ValueError("명세서 회차를 입력하세요")
        return self

    def rows(self):
        rows = schedule(self.principal, self.months, self.first_due_date)
        if self.statement is not None:
            for row, statement in zip(rows, self.statement):
                row.update(statement.model_dump())
        return rows


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
    amount: Nonnegative
    interest_charge_id: Id | None = None
    fee_charge_id: Id | None = None
    interest: Nonnegative = 0
    fee: Nonnegative = 0

    @model_validator(mode="after")
    def positive_total(self):
        if not (self.amount or self.interest or self.fee):
            raise ValueError("배분할 금액을 입력하세요")
        return self


class Allocate(Command):
    transaction_id: Id
    kind: Literal[
        "payment", "refund", "charge", "billed_payment", "rebate", "charge_refund"
    ] = "payment"
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


def row_balances(principal, statement, allocations):
    """A prior charge moves the expense to the card. Its payment only clears debt."""
    totals = Counter()
    settled = 0
    for entry in allocations:
        settled += entry["amount"]
        for component in ("interest", "fee"):
            kind = entry["kind"]
            if kind == "billed_payment" and entry[f"{component}_charge_id"] is None:
                kind = "payment"
            totals[kind, component] += entry[component]
    remaining = principal - settled
    if remaining < 0:
        raise DomainValidationError("배분액이 회차의 남은 원금을 넘습니다")
    result = dict(
        settled=settled, remaining=remaining, unpaid_total=remaining, **statement
    )
    for component, adjustment in (
        ("interest", -statement["cancelled_interest"]),
        ("fee", statement["early_fee"]),
    ):
        billed = totals["charge", component]
        paid = totals["billed_payment", component]
        direct = totals["payment", component]
        reversed_bill = totals["charge_refund", component]
        outstanding_bill = billed - paid - reversed_bill
        unbooked = (statement[component] or 0) + adjustment - billed - direct
        if unbooked < 0 or outstanding_bill < 0:
            raise DomainValidationError(
                "비용 배분이 해당 날짜의 회차 확정액 또는 선기장 미납액을 넘습니다"
            )
        if totals["rebate", component] > direct + paid:
            raise DomainValidationError("비용 환급액이 이미 납부한 비용을 넘습니다")
        result[f"unbooked_{component}"] = unbooked
        result[f"remaining_{component}"] = unbooked + outstanding_bill
        result["unpaid_total"] += unbooked + outstanding_bill
    return result
