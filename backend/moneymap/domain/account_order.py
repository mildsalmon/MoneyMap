"""Sibling-order commands and snapshot validation, independent of persistence."""
from pydantic import BaseModel, Field

from .account import Account, AccountType
from .errors import DomainConflictError, DomainNotFoundError, DomainValidationError
from .services import is_account_group


class AccountOrderItem(BaseModel):
    id: int
    version: int = Field(ge=1)


class AccountReorderCommand(BaseModel):
    type: AccountType
    parent_id: int | None
    ordered_accounts: list[AccountOrderItem] = Field(min_length=2)


class AccountReorderEffects(BaseModel):
    changed_account_ids: list[int]


class AccountReorderResult(BaseModel):
    accounts: list[Account]
    effects: AccountReorderEffects


def validate_reorder(command: AccountReorderCommand, accounts: list[Account]) -> list[Account]:
    """Validate in documented precedence; return all eligible siblings in old order."""
    ids = [item.id for item in command.ordered_accounts]
    if len(set(ids)) != len(ids):
        raise DomainValidationError("중복 계정이 있습니다", code="account_reorder_duplicate")
    by_id = {a.id: a for a in accounts}
    if command.parent_id is not None:
        parent = by_id.get(command.parent_id)
        if parent is None:
            raise DomainNotFoundError("상위 계정이 없습니다", code="account_reorder_parent_not_found")
        if parent.archived or parent.is_system or not is_account_group(parent, accounts):
            raise DomainConflictError("순서를 변경할 수 없는 그룹입니다", code="account_reorder_parent_forbidden")
        if parent.type != command.type:
            raise DomainConflictError("상위 계정 유형이 다릅니다", code="account_reorder_parent_type_mismatch")
    if any(i not in by_id for i in ids):
        raise DomainNotFoundError("계정이 없습니다", code="account_reorder_account_not_found")
    selected = [by_id[i] for i in ids]
    if any(a.archived or a.is_system for a in selected):
        raise DomainConflictError("보관·시스템 계정은 이동할 수 없습니다", code="account_reorder_forbidden")
    if any(a.type != command.type or a.parent_id != command.parent_id for a in selected):
        raise DomainConflictError("같은 분류 안에서만 이동할 수 있습니다", code="account_reorder_scope_mismatch")
    eligible = sorted(
        (a for a in accounts if a.type == command.type and a.parent_id == command.parent_id
         and not a.archived and not a.is_system), key=lambda a: (a.position, a.id),
    )
    if {a.id for a in eligible} != set(ids):
        raise DomainConflictError("계정 목록이 변경되었습니다", code="account_reorder_set_mismatch")
    if any(by_id[item.id].version != item.version for item in command.ordered_accounts):
        raise DomainConflictError("다른 변경이 있습니다. 최신 순서를 불러오세요", code="account_reorder_stale")
    return eligible
