"""리포지토리가 필요한 도메인 검증 — 엔티티 단독으로는 못 지키는 invariant.

- 부모 타입 일치: parent는 같은 type의 다른 계정 (설계서 원본 invariant)
- 순환 방지 (D8): 부모 체인을 따라가며 자기 자신이 나오면 거부
"""

from __future__ import annotations

from moneymap.domain.account import Account, AccountSettingsCommand, AccountType
from moneymap.domain.errors import (
    DomainConflictError,
    DomainValidationError,
    DomainNotFoundError,
)


_TYPE_LABELS: dict[AccountType, str] = {
    AccountType.ASSET: "자산",
    AccountType.LIABILITY: "부채",
    AccountType.INCOME: "수익",
    AccountType.EXPENSE: "비용",
    AccountType.EQUITY: "자본",
}


def normalize_account_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise DomainValidationError(
            "계정 이름을 입력하세요",
            code="account_name_required",
        )
    return cleaned


def account_name_key(name: str) -> str:
    return normalize_account_name(name).casefold()


def is_account_group(account: Account, accounts: list[Account]) -> bool:
    return account.is_placeholder or any(
        child.parent_id == account.id for child in accounts
    )


def account_path(parent_id: int | None, account_type: AccountType, accounts: list[Account]) -> str:
    parts = [_TYPE_LABELS[account_type]]
    by_id = {account.id: account for account in accounts if account.id is not None}
    chain: list[str] = []
    seen: set[int] = set()
    current_id = parent_id
    while current_id is not None and current_id not in seen:
        seen.add(current_id)
        current = by_id.get(current_id)
        if current is None:
            break
        chain.append(current.name)
        current_id = current.parent_id
    return " > ".join([*parts, *reversed(chain)])


def validate_name_available(
    desired: Account,
    accounts: list[Account],
    *,
    exclude_id: int | None = None,
) -> None:
    target = account_name_key(desired.name)
    for existing in accounts:
        if existing.id == exclude_id:
            continue
        if existing.type != desired.type or existing.parent_id != desired.parent_id:
            continue
        if account_name_key(existing.name) != target:
            continue
        target_path = account_path(desired.parent_id, desired.type, accounts)
        archived_note = " (보관된 계정)" if existing.archived else ""
        raise DomainConflictError(
            f"선택한 위치 '{target_path}'에 이미 '{existing.name}' 계정이 있습니다{archived_note}",
            code="account_name_conflict",
            context={
                "conflicting_account_id": existing.id,
                "conflicting_account_archived": existing.archived,
                "target_path": target_path,
            },
        )


def validate_parent_target(
    current: Account | None,
    desired: Account,
    accounts: list[Account],
    *,
    require_group: bool,
) -> None:
    if desired.parent_id is None:
        return
    by_id = {account.id: account for account in accounts if account.id is not None}
    parent = by_id.get(desired.parent_id)
    if parent is None:
        raise DomainNotFoundError(
            "상위 계정이 없습니다",
            code="account_parent_not_found",
        )
    if parent.archived:
        raise DomainConflictError(
            "보관된 계정은 상위 그룹으로 선택할 수 없습니다",
            code="archived_account_parent_forbidden",
        )
    if parent.is_system:
        raise DomainConflictError(
            "시스템 계정은 상위 그룹으로 선택할 수 없습니다",
            code="system_account_parent_forbidden",
        )
    if parent.type != desired.type:
        raise DomainConflictError(
            "같은 계정 유형의 상위 그룹만 선택할 수 있습니다",
            code="account_parent_type_mismatch",
        )

    seen: set[int] = set()
    cursor: Account | None = parent
    while cursor is not None and cursor.id is not None:
        if current is not None and cursor.id == current.id:
            raise DomainConflictError(
                "자기 자신이나 하위 계정을 상위 그룹으로 선택할 수 없습니다",
                code="account_cycle",
            )
        if cursor.id in seen:
            raise DomainConflictError(
                "계정 트리에 순환이 있어 이동할 수 없습니다",
                code="account_cycle",
            )
        seen.add(cursor.id)
        cursor = by_id.get(cursor.parent_id)

    if parent.is_overdraft:
        raise DomainConflictError(
            "마이너스통장 계정은 상위 그룹이 될 수 없습니다",
            code="overdraft_parent_forbids_children",
        )
    if require_group and not is_account_group(parent, accounts):
        raise DomainConflictError(
            "상위 계정으로 사용할 그룹을 선택하세요",
            code="account_parent_requires_group",
        )


def validate_overdraft_eligibility(desired: Account, accounts: list[Account]) -> None:
    if not desired.is_overdraft:
        return
    if desired.type != AccountType.ASSET or desired.is_system:
        raise DomainConflictError(
            "마이너스통장은 자산 계정에만 설정할 수 있습니다",
            code="overdraft_invalid_account",
        )
    if desired.is_placeholder:
        raise DomainConflictError(
            "그룹 계정은 마이너스통장으로 설정할 수 없습니다",
            code="overdraft_cannot_be_group",
        )
    if desired.id is not None and any(
        account.parent_id == desired.id for account in accounts
    ):
        raise DomainConflictError(
            "하위 계정이 있는 계정은 마이너스통장으로 설정할 수 없습니다",
            code="overdraft_requires_leaf",
        )


def validate_account_create(account: Account, accounts: list[Account]) -> Account:
    desired = account.model_copy(update={"name": normalize_account_name(account.name)})
    validate_parent_target(None, desired, accounts, require_group=False)
    validate_name_available(desired, accounts)
    validate_overdraft_eligibility(desired, accounts)
    return desired


def validate_account_settings_transition(
    current: Account,
    command: AccountSettingsCommand,
    accounts: list[Account],
) -> Account:
    if current.archived:
        raise DomainConflictError(
            "보관된 계정은 복원한 뒤 설정을 변경하세요",
            code="archived_account_read_only",
        )
    if current.is_system:
        raise DomainConflictError(
            "시스템 계정은 설정을 변경할 수 없습니다",
            code="system_account_read_only",
        )
    desired = current.model_copy(
        update={
            "name": normalize_account_name(command.name),
            "parent_id": command.parent_id,
            "is_overdraft": command.is_overdraft,
        }
    )
    if desired.parent_id != current.parent_id:
        validate_parent_target(current, desired, accounts, require_group=True)
    validate_name_available(desired, accounts, exclude_id=current.id)
    validate_overdraft_eligibility(desired, accounts)
    return desired


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
