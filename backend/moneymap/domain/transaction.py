"""Transaction / Posting — 복식부기의 코어.

    Transaction "저녁 회식 52,000 (카드)"
    ├── Posting  식비(비용)      +52,000   ← 차변
    └── Posting  현대카드(부채)  −52,000   ← 대변
                                 ───────
                        합계 =        0   ← invariant 1 (balanced)
    모든 posting의 currency 동일       ← invariant 2 (single-currency)

이 두 invariant는 여기(도메인)와 SQLite 트리거에서 이중으로 enforce된다.
"""

from __future__ import annotations

import datetime

from pydantic import BaseModel, Field, model_validator

from moneymap.domain.errors import MixedCurrencyError, UnbalancedTransactionError
from moneymap.domain.money import Money


class Posting(BaseModel):
    model_config = {"frozen": True}

    account_id: int
    amount: Money  # 양수=차변, 음수=대변

    @model_validator(mode="after")
    def _nonzero(self) -> "Posting":
        if self.amount.amount == 0:
            raise ValueError("0원 posting은 허용되지 않습니다")
        return self


class Transaction(BaseModel):
    id: int | None = None
    scenario_id: int
    date: datetime.date
    description: str = ""
    memo: str = ""
    postings: list[Posting] = Field(min_length=2)
    # 반복 규칙이 자동 생성한 거래는 출처를 추적한다 (UI badge용, D10).
    # 생성 후 규칙과 독립 — 규칙 수정은 이 거래를 건드리지 않는다 (D9).
    source_rule_id: int | None = None

    @model_validator(mode="after")
    def _enforce_invariants(self) -> "Transaction":
        currencies = {p.amount.currency for p in self.postings}
        if len(currencies) > 1:
            raise MixedCurrencyError(
                f"한 거래의 모든 금액은 같은 통화여야 합니다: {sorted(currencies)}"
            )
        total = sum(p.amount.amount for p in self.postings)
        if total != 0:
            raise UnbalancedTransactionError(
                f"차변과 대변의 합이 0이 아닙니다: {total:+d}"
            )
        return self
