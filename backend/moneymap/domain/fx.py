"""Cash exchanges in native minor units. Rates quote KRW per whole foreign unit."""

from datetime import date
from typing import Annotated, Literal
from uuid import UUID
from fractions import Fraction

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .money import MINOR_UNITS

Currency = Literal["USD", "JPY", "EUR", "BHD"]
Source = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
]
Rate = Annotated[str, Field(pattern=r"^[0-9]{1,12}(\.[0-9]{1,9})?$")]
Amount = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,15})$")]


class Quote(BaseModel):
    model_config = ConfigDict(extra="forbid")
    currency: Currency
    rate: Rate
    rate_date: date
    source: Source

    @model_validator(mode="after")
    def positive_rate(self):
        if Fraction(self.rate) <= 0:
            raise ValueError("환율은 0보다 커야 합니다")
        return self


class Trade(Quote):
    day: date
    side: Literal["buy", "sell"]
    bank_id: int = Field(strict=True, gt=0, le=2**53 - 1)
    quantity: Annotated[str, Field(pattern=r"^[0-9]{1,16}(\.[0-9]{1,3})?$")]
    cash: Amount  # confirmed total paid or received, net of fee
    fee: Amount

    @property
    def minor(self):
        return int(Fraction(self.quantity) * 10 ** MINOR_UNITS[self.currency])

    @property
    def principal(self):
        return int(self.cash) + (-1 if self.side == "buy" else 1) * int(self.fee)

    @model_validator(mode="after")
    def valid_amounts(self):
        digits = MINOR_UNITS[self.currency]
        if (
            len(self.quantity.partition(".")[2]) > digits
            or not 0 < self.minor <= 2**53 - 1
        ):
            raise ValueError("통화의 최소 단위와 수량 범위를 확인하세요")
        if not 0 < int(self.cash) <= 2**53 - 1 or not 0 < self.principal <= 2**53 - 1:
            raise ValueError("실제 입출금액과 수수료를 확인하세요")
        return self


class SaveTrade(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    trade: Trade
    expected_version: int = Field(default=0, ge=0)


class LegacySelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transaction_id: int = Field(gt=0, le=2**53 - 1)
    trade: Trade


class ApplySelection(LegacySelection):
    preview_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


def round_won(value: Fraction) -> int:
    """Round half up without floating point or intermediate decimal rounding."""
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)
