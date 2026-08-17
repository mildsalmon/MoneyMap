"""리포지토리가 필요한 도메인 검증 — 엔티티 단독으로는 못 지키는 invariant.

- 부모 타입 일치: parent는 같은 type의 다른 계정 (설계서 원본 invariant)
- 순환 방지 (D8): 부모 체인을 따라가며 자기 자신이 나오면 거부
"""

from __future__ import annotations

from moneymap.domain.account import Account, AccountType
from moneymap.domain.errors import (
    AccountCycleError,
    DomainConflictError,
    DomainError,
    DomainValidationError,
)
from moneymap.domain.ports import AccountRepository


def validate_account_placement(account: Account, repo: AccountRepository) -> None:
    """계정 저장 전 부모 관련 invariant를 검사한다. 위반 시 DomainError."""
    if account.parent_id is None:
        return
    if account.id is not None and account.parent_id == account.id:
        raise AccountCycleError("계정은 자기 자신을 부모로 가질 수 없습니다")

    parent = repo.find_by_id(account.parent_id)
    if parent is None:
        raise DomainError(f"부모 계정이 존재하지 않습니다: id={account.parent_id}")
    if parent.type != account.type:
        raise DomainError(
            f"부모 계정의 타입이 다릅니다: {parent.type} != {account.type}"
        )
    if parent.is_overdraft:
        raise DomainConflictError(
            "마이너스통장 계정 아래에는 하위 계정을 만들 수 없습니다",
            code="overdraft_parent_forbids_children",
        )

    # 순환 검사: account를 저장하면 생길 부모 체인을 위로 따라간다.
    # 체인 어디서든 자기 자신(account.id)이 나오면 순환.
    seen: set[int] = set()
    current: Account | None = parent
    while current is not None:
        if current.id is None:
            break
        if account.id is not None and current.id == account.id:
            raise AccountCycleError(
                f"순환하는 부모 지정입니다: {account.name} → ... → {current.name}"
            )
        if current.id in seen:  # 기존 데이터가 이미 오염된 경우도 무한 루프 방지
            raise AccountCycleError("계정 트리에 이미 순환이 존재합니다")
        seen.add(current.id)
        current = (
            repo.find_by_id(current.parent_id) if current.parent_id is not None else None
        )


def validate_overdraft_shape(account: Account) -> None:
    """마이너스통장으로 저장 가능한 계정 자체의 순수 조건."""
    if not account.is_overdraft:
        return
    if (
        account.type != AccountType.ASSET
        or account.is_system
        or account.is_placeholder
    ):
        raise DomainValidationError(
            "마이너스통장은 실제 자산 leaf 계정에만 설정할 수 있습니다",
            code="overdraft_invalid_account",
        )


def validate_overdraft_transition(
    current: Account,
    desired: Account,
    repo: AccountRepository,
) -> None:
    """설정 변경 시 보관/자식 상태까지 포함해 검사한다."""
    if current.archived:
        raise DomainConflictError(
            "보관된 계정은 복원한 뒤 설정을 변경하세요",
            code="archived_account_read_only",
        )
    validate_overdraft_shape(desired)
    if desired.is_overdraft and desired.id is not None and repo.has_children(desired.id):
        raise DomainConflictError(
            "하위 계정이 있는 계정은 마이너스통장으로 설정할 수 없습니다",
            code="overdraft_requires_leaf",
        )


def opening_balance_posting_amount(
    account: Account,
    amount: int,
    state: str,
    *,
    has_children: bool,
) -> int:
    """개시잔액 UI 상태를 원장 signed posting으로 변환한다."""
    if amount <= 0:
        raise DomainValidationError(
            "개시잔액 금액은 0보다 커야 합니다",
            code="invalid_opening_amount",
        )
    if state not in {"positive", "negative"}:
        raise DomainValidationError(
            "개시잔액 상태가 올바르지 않습니다",
            code="invalid_opening_state",
        )
    if account.is_system or account.is_placeholder or has_children:
        raise DomainValidationError(
            "그룹 또는 시스템 계정에는 개시잔액을 기록할 수 없습니다",
            code="opening_invalid_account",
        )
    if account.type == AccountType.ASSET:
        if state == "negative" and not account.is_overdraft:
            raise DomainValidationError(
                "마이너스 사용 개시잔액은 마이너스통장 계정에만 기록할 수 있습니다",
                code="negative_opening_requires_overdraft",
            )
        return amount if state == "positive" else -amount
    if account.type == AccountType.LIABILITY:
        if state != "negative":
            raise DomainValidationError(
                "부채 계정의 개시잔액은 부채 상태로 기록해야 합니다",
                code="invalid_opening_state",
            )
        return -amount
    raise DomainValidationError(
        "이 계정 유형에는 개시잔액을 기록할 수 없습니다",
        code="opening_invalid_account",
    )
