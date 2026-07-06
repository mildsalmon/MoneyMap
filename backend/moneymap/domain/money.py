"""Money 값 객체 — Stripe 컨벤션 (minor unit 정수).

    KRW: amount = 원   (minor unit 0)  → 1000  = 1,000원
    USD: amount = 센트 (minor unit 2)  → 1500  = $15.00
    JPY: amount = 엔   (minor unit 0)  → 1500  = ¥1,500

부호: 양수 = 차변(debit), 음수 = 대변(credit).
Python int는 무한 정밀도라 오버플로 걱정 없음. 부동소수는 어디서도 안 거침.
산술은 같은 currency끼리만 — 다중통화 거래는 v1에서 거부(환전은 v2).
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from moneymap.domain.errors import MixedCurrencyError

# ISO 4217 minor unit 표 (v1에서 실제 쓰는 통화만; 확장 시 여기에 추가)
MINOR_UNITS: dict[str, int] = {"KRW": 0, "USD": 2, "EUR": 2, "JPY": 0, "BHD": 3}

DEFAULT_CURRENCY = "KRW"


class Money(BaseModel):
    model_config = {"frozen": True}

    amount: int
    currency: str = Field(default=DEFAULT_CURRENCY, min_length=3, max_length=3)

    @field_validator("currency")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    def _check_same_currency(self, other: "Money") -> None:
        if self.currency != other.currency:
            raise MixedCurrencyError(
                f"통화가 다른 금액끼리 연산할 수 없습니다: {self.currency} vs {other.currency}"
            )

    def __add__(self, other: "Money") -> "Money":
        self._check_same_currency(other)
        return Money(amount=self.amount + other.amount, currency=self.currency)

    def __sub__(self, other: "Money") -> "Money":
        self._check_same_currency(other)
        return Money(amount=self.amount - other.amount, currency=self.currency)

    def __neg__(self) -> "Money":
        return Money(amount=-self.amount, currency=self.currency)
