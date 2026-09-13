"""Explicit edit commands: historical exceptions are proven from original rows."""
from __future__ import annotations

import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .account import Account
from .errors import DomainValidationError
from .money import Money
from .services import opening_balance_posting_amount
from .transaction import Posting, Transaction

MAX_TOTAL = 9_007_199_254_740_991


class EditPosting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    posting_id: int | None = Field(default=None, strict=True, gt=0)
    account_id: int = Field(strict=True, gt=0)
    amount: int = Field(strict=True, ge=-MAX_TOTAL, le=MAX_TOTAL)


class OpeningEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: int = Field(strict=True, gt=0)
    signed_amount: int = Field(strict=True, ge=-MAX_TOTAL, le=MAX_TOTAL)


class TransactionEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: str = Field(pattern=r"^[0-9a-f]{32}$")
    request_id: str = Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    date: datetime.date
    description: str = Field(max_length=2000)
    memo: str = Field(max_length=10000)
    tags: list[str] = Field(max_length=20)
    postings: list[EditPosting] | None = Field(default=None, min_length=2, max_length=100)
    opening: OpeningEdit | None = None

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags):
        return Transaction._normalize_tags(tags)

    @model_validator(mode="after")
    def shape(self):
        if (self.postings is None) == (self.opening is None):
            raise ValueError("분개 또는 개시잔액 중 한 가지 수정만 제출하세요")
        postings = self.postings or []
        if sum(max(p.amount, 0) for p in postings) > MAX_TOTAL or sum(max(-p.amount, 0) for p in postings) > MAX_TOTAL:
            raise ValueError("거래 합계가 허용 범위를 넘습니다")
        return self


class ExistingPosting(BaseModel):
    posting_id: int
    account_id: int
    amount: int
    currency: str


class TransactionDetail(BaseModel):
    id: int
    version: str
    date: datetime.date
    description: str
    memo: str
    tags: list[str]
    source_rule_id: int | None
    entry_origin: str
    postings: list[ExistingPosting]
    kind: Literal["regular", "opening", "legacy_opening_zero"] = "regular"
    opening_system_id: int | None = None
    editable: bool = True


def edited_postings(command: TransactionEdit, original: TransactionDetail, accounts: list[Account]) -> list[EditPosting]:
    """Do not trust client IDs as capabilities; bind them to this original row."""
    by_id = {a.id: a for a in accounts}
    groups = {a.parent_id for a in accounts}
    before = {p.posting_id: p for p in original.postings}

    def usable(account_id: int, retained: bool = False) -> Account:
        account = by_id.get(account_id)
        if account is None or account.is_system:
            raise DomainValidationError("사용할 수 없는 계정입니다", code="account_unavailable")
        if not retained and (account.archived or account.is_placeholder or account.id in groups or account.currency != "KRW"):
            raise DomainValidationError("현재 사용 가능한 원화 계정을 선택하세요", code="account_unavailable")
        return account

    if original.kind != "regular":
        if command.opening is None:
            raise DomainValidationError("개시잔액의 두 행 구조는 바꿀 수 없습니다", code="opening_structure")
        target = next(p for p in original.postings if p.account_id != original.opening_system_id)
        system = next(p for p in original.postings if p.account_id == original.opening_system_id)
        desired = command.opening
        retained = desired.account_id == target.account_id
        account = usable(desired.account_id, retained)
        if desired.signed_amount == 0:
            if target.amount != 0:
                raise DomainValidationError("새로운 0원 개시잔액은 허용되지 않습니다", code="zero_posting")
            if not retained and account.type not in {"asset", "liability"}:
                raise DomainValidationError("이 계정 유형에는 개시잔액을 기록할 수 없습니다", code="opening_invalid_account")
        elif not (retained and desired.signed_amount == target.amount):
            # Existing group/archive references survive, but a changed sign/target
            # still follows opening-balance accounting rules.
            relaxed = account.model_copy(update={"is_placeholder": False}) if retained else account
            opening_balance_posting_amount(relaxed, abs(desired.signed_amount),
                "positive" if desired.signed_amount > 0 else "negative",
                has_children=False if retained else account.id in groups)
        return [EditPosting(posting_id=target.posting_id, account_id=desired.account_id, amount=desired.signed_amount),
                EditPosting(posting_id=system.posting_id, account_id=system.account_id, amount=-desired.signed_amount)]

    if command.postings is None:
        raise DomainValidationError("일반 거래를 개시잔액으로 변경할 수 없습니다", code="opening_structure")
    seen = set()
    result = command.postings
    for posting in result:
        previous = before.get(posting.posting_id)
        if posting.posting_id is not None:
            if previous is None or posting.posting_id in seen:
                raise DomainValidationError("원래 거래의 분개 행을 확인하세요", code="posting_identity")
            seen.add(posting.posting_id)
        usable(posting.account_id, previous is not None and previous.account_id == posting.account_id)
        if posting.amount == 0 and (previous is None or previous.amount != 0):
            raise DomainValidationError("기존 0원 행만 유지할 수 있습니다", code="zero_posting")
    return result


def validate_balanced(command: TransactionEdit, postings: list[EditPosting]) -> None:
    Transaction(scenario_id=1, date=command.date, description=command.description,
        memo=command.memo, tags=command.tags,
        postings=[Posting(account_id=p.account_id, amount=Money(amount=p.amount), legacy_zero=p.amount == 0) for p in postings])
