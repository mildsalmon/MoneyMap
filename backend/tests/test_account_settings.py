import pytest

from moneymap.domain import (
    Account,
    AccountSettingsCommand,
    AccountType,
    DomainConflictError,
    DomainNotFoundError,
    DomainValidationError,
)
from moneymap.domain.services import (
    account_name_key,
    normalize_account_name,
    validate_account_create,
    validate_account_settings_transition,
)


def command(account: Account, **changes) -> AccountSettingsCommand:
    values = {
        "account_id": account.id,
        "name": account.name,
        "parent_id": account.parent_id,
        "is_overdraft": account.is_overdraft,
        "version": account.version,
        **changes,
    }
    return AccountSettingsCommand(**values)


def test_account_name_policy_trims_edges_and_casefolds_only():
    assert normalize_account_name("  기업 은행  ") == "기업 은행"
    assert account_name_key(" Toss ") == "toss"
    with pytest.raises(DomainValidationError) as error:
        normalize_account_name("   ")
    assert error.value.code == "account_name_required"


def test_settings_name_conflict_includes_structured_target_context():
    parent = Account(
        id=1,
        name="입출금통장",
        type=AccountType.ASSET,
        is_placeholder=True,
        position=1,
    )
    existing = Account(
        id=2,
        name="기업은행",
        type=AccountType.ASSET,
        parent_id=parent.id,
        archived=True,
        position=1,
    )
    current = Account(
        id=3,
        name="임시",
        type=AccountType.ASSET,
        parent_id=parent.id,
        position=2,
    )

    with pytest.raises(DomainConflictError) as error:
        validate_account_settings_transition(
            current,
            command(current, name=" 기업은행 "),
            [parent, existing, current],
        )

    assert error.value.code == "account_name_conflict"
    assert error.value.context == {
        "conflicting_account_id": existing.id,
        "conflicting_account_archived": True,
        "target_path": "자산 > 입출금통장",
    }


@pytest.mark.parametrize(
    ("parent", "code"),
    [
        (None, "account_parent_not_found"),
        (
            Account(
                id=2,
                name="보관 그룹",
                type=AccountType.ASSET,
                archived=True,
                is_placeholder=True,
                position=1,
            ),
            "archived_account_parent_forbidden",
        ),
        (
            Account(
                id=2,
                name="시스템",
                type=AccountType.ASSET,
                is_system=True,
                is_placeholder=True,
                position=1,
            ),
            "system_account_parent_forbidden",
        ),
        (
            Account(
                id=2,
                name="비용 그룹",
                type=AccountType.EXPENSE,
                is_placeholder=True,
                position=1,
            ),
            "account_parent_type_mismatch",
        ),
        (
            Account(
                id=2,
                name="마이너스통장",
                type=AccountType.ASSET,
                is_overdraft=True,
                position=1,
            ),
            "overdraft_parent_forbids_children",
        ),
        (
            Account(
                id=2,
                name="일반 계정",
                type=AccountType.ASSET,
                position=1,
            ),
            "account_parent_requires_group",
        ),
    ],
)
def test_settings_parent_validation_has_stable_error_codes(parent, code):
    current = Account(id=1, name="통장", type=AccountType.ASSET, position=1)
    accounts = [current, *([parent] if parent is not None else [])]
    with pytest.raises((DomainConflictError, DomainNotFoundError)) as error:
        validate_account_settings_transition(
            current,
            command(current, parent_id=2),
            accounts,
        )
    assert error.value.code == code


def test_settings_rejects_self_or_descendant_parent_but_grandfathers_same_parent():
    legacy_parent = Account(id=1, name="레거시 leaf", type=AccountType.ASSET, position=1)
    current = Account(
        id=2,
        name="현재",
        type=AccountType.ASSET,
        parent_id=legacy_parent.id,
        position=1,
    )
    child = Account(
        id=3,
        name="하위",
        type=AccountType.ASSET,
        parent_id=current.id,
        position=1,
    )
    accounts = [legacy_parent, current, child]

    unchanged_parent = validate_account_settings_transition(
        current,
        command(current, name="현재 이름 변경"),
        accounts,
    )
    assert unchanged_parent.parent_id == legacy_parent.id

    with pytest.raises(DomainConflictError) as error:
        validate_account_settings_transition(
            current,
            command(current, parent_id=child.id),
            accounts,
        )
    assert error.value.code == "account_cycle"


def test_overdraft_validation_uses_type_then_group_then_children_precedence():
    child = Account(
        id=2,
        name="하위",
        type=AccountType.LIABILITY,
        parent_id=1,
        position=1,
    )
    current = Account(
        id=1,
        name="부채 그룹",
        type=AccountType.LIABILITY,
        is_placeholder=True,
        position=1,
    )
    with pytest.raises(DomainConflictError) as error:
        validate_account_settings_transition(
            current,
            command(current, is_overdraft=True),
            [current, child],
        )
    assert error.value.code == "overdraft_invalid_account"


def test_create_allows_first_child_but_rejects_forbidden_parent_shapes():
    leaf = Account(id=1, name="새 그룹 후보", type=AccountType.ASSET, position=1)
    child = validate_account_create(
        Account(name="첫 자식", type=AccountType.ASSET, parent_id=leaf.id),
        [leaf],
    )
    assert child.parent_id == leaf.id

    archived = leaf.model_copy(update={"archived": True})
    with pytest.raises(DomainConflictError) as error:
        validate_account_create(
            Account(name="자식", type=AccountType.ASSET, parent_id=archived.id),
            [archived],
        )
    assert error.value.code == "archived_account_parent_forbidden"
