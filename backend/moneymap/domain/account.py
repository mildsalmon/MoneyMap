"""Account 엔티티.

개시잔액은 `자본:개시잔액` equity 계정 상대의 일반 거래로 기록되고,
잔액은 언제나 "거래 합산" 단일 경로다.

잔액 표시 부호 (설계서 부호 컨벤션):

    잔액 표시 = SUM(postings.amount) × multiplier
      asset, expense           → +1 (차변 잔액이 자연 양수)
      liability, income, equity → −1 (대변 잔액이 자연 양수)

부모 타입 일치·순환 방지는 저장 시점에 리포지토리가 필요하므로
services.validate_account_placement()에서 검사한다.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field

from moneymap.domain.money import DEFAULT_CURRENCY


class AccountType(StrEnum):
    ASSET = "asset"
    LIABILITY = "liability"
    INCOME = "income"
    EXPENSE = "expense"
    EQUITY = "equity"


# 잔액 표시 시점에만 적용하는 부호 배수 — 저장 데이터에는 절대 안 섞는다.
SIGN_MULTIPLIER: dict[AccountType, int] = {
    AccountType.ASSET: 1,
    AccountType.EXPENSE: 1,
    AccountType.LIABILITY: -1,
    AccountType.INCOME: -1,
    AccountType.EQUITY: -1,
}

# init 시 시드되는 개시잔액 상대 계정 이름 (D4)
OPENING_BALANCE_ACCOUNT_NAME = "개시잔액"


class Account(BaseModel):
    id: int | None = None
    name: str = Field(min_length=1)
    type: AccountType
    parent_id: int | None = None
    currency: str = Field(default=DEFAULT_CURRENCY, min_length=3, max_length=3)
    # 소프트 삭제 (D23): 거래 역사를 지키기 위해 계정은 지우지 않고 보관한다.
    # 보관된 계정은 입력 UI에서 숨지만 과거 거래·잔액 조회에는 그대로 남는다.
    archived: bool = False
    # 그룹/대분류 (D24, placeholder): 자식을 묶어 집계만 하는 계정. 직접 기장 금지.
    # 실제 비기장 판정은 "is_placeholder OR 자식 있음" — 자식이 붙으면 자동으로 그룹.
    is_placeholder: bool = False
    # 시스템 계정: 장부 균형을 위해 앱이 관리하는 내부 계정. 사용자가 이름을 바꾸지 않는다.
    is_system: bool = False
    # 마이너스통장: 저장 type은 asset으로 유지하고 음수 잔액만 보고 시점에
    # liability로 분류한다. 계정 id/부모/거래 참조는 바뀌지 않는다.
    is_overdraft: bool = False

    def display_multiplier(self) -> int:
        return SIGN_MULTIPLIER[self.type]


def reporting_type(account: Account, raw_balance: int) -> AccountType:
    """저장 계정 타입과 별개인 조회 시점 보고 분류."""
    if account.is_overdraft and raw_balance < 0:
        return AccountType.LIABILITY
    return account.type
