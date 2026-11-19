"""A statement uses the account's display sign and the currency's minor units."""
from datetime import date
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from moneymap.domain.money import MINOR_UNITS


class Statement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: int = Field(strict=True, gt=0, le=2**63 - 1)
    currency: str
    closing_date: date
    statement_minor: str = Field(pattern=r"^-?(0|[1-9][0-9]*)$", max_length=20)

    @field_validator("currency")
    @classmethod
    def known_currency(cls, value: str) -> str:
        if value not in MINOR_UNITS:
            raise ValueError("지원하는 통화를 선택하세요")
        return value

    @field_validator("statement_minor")
    @classmethod
    def bounded_amount(cls, value: str) -> str:
        if abs(int(value)) > 2**63:
            raise ValueError("명세서 잔액이 허용 범위를 넘습니다")
        return str(int(value))


class Adjustment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    statement: Statement
    preview_version: str = Field(pattern=r"^[0-9a-f]{64}$")
    request_id: UUID
    counterpart_id: int = Field(strict=True, gt=0, le=2**63 - 1)
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
