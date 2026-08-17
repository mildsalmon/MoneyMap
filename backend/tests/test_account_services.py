import pytest

from moneymap.domain import (
    Account,
    AccountCycleError,
    AccountType,
    DomainConflictError,
    DomainError,
    DomainValidationError,
    reporting_type,
)
from moneymap.domain.services import (
    opening_balance_posting_amount,
    validate_account_placement,
    validate_overdraft_shape,
    validate_overdraft_transition,
)


class InMemoryAccountRepo:
    """도메인 포트의 인메모리 구현 — 테스트 전용."""

    def __init__(self) -> None:
        self._by_id: dict[int, Account] = {}
        self._next_id = 1

    def save(self, account: Account) -> Account:
        if account.id is None:
            account = account.model_copy(update={"id": self._next_id})
            self._next_id += 1
        assert account.id is not None
        self._by_id[account.id] = account
        return account

    def find_by_id(self, account_id: int) -> Account | None:
        return self._by_id.get(account_id)

    def find_all(self) -> list[Account]:
        return list(self._by_id.values())

    def has_children(self, account_id: int) -> bool:
        return any(a.parent_id == account_id for a in self._by_id.values())


@pytest.fixture
def repo() -> InMemoryAccountRepo:
    return InMemoryAccountRepo()


def test_root_account_ok(repo: InMemoryAccountRepo):
    validate_account_placement(Account(name="자산", type=AccountType.ASSET), repo)


def test_valid_parent_ok(repo: InMemoryAccountRepo):
    parent = repo.save(Account(name="자산", type=AccountType.ASSET))
    child = Account(name="Toss", type=AccountType.ASSET, parent_id=parent.id)
    validate_account_placement(child, repo)


def test_self_parent_rejected(repo: InMemoryAccountRepo):
    a = repo.save(Account(name="A", type=AccountType.ASSET))
    with pytest.raises(AccountCycleError):
        validate_account_placement(a.model_copy(update={"parent_id": a.id}), repo)


def test_two_node_cycle_rejected(repo: InMemoryAccountRepo):
    # A의 부모를 B로, B의 부모를 A로 (D8의 대표 케이스)
    a = repo.save(Account(name="A", type=AccountType.ASSET))
    b = repo.save(Account(name="B", type=AccountType.ASSET, parent_id=a.id))
    with pytest.raises(AccountCycleError):
        validate_account_placement(a.model_copy(update={"parent_id": b.id}), repo)


def test_deep_cycle_rejected(repo: InMemoryAccountRepo):
    a = repo.save(Account(name="A", type=AccountType.ASSET))
    b = repo.save(Account(name="B", type=AccountType.ASSET, parent_id=a.id))
    c = repo.save(Account(name="C", type=AccountType.ASSET, parent_id=b.id))
    with pytest.raises(AccountCycleError):
        validate_account_placement(a.model_copy(update={"parent_id": c.id}), repo)


def test_type_mismatch_rejected(repo: InMemoryAccountRepo):
    parent = repo.save(Account(name="자산", type=AccountType.ASSET))
    child = Account(name="식비", type=AccountType.EXPENSE, parent_id=parent.id)
    with pytest.raises(DomainError):
        validate_account_placement(child, repo)


def test_missing_parent_rejected(repo: InMemoryAccountRepo):
    child = Account(name="고아", type=AccountType.ASSET, parent_id=999)
    with pytest.raises(DomainError):
        validate_account_placement(child, repo)


@pytest.mark.parametrize(
    ("raw_balance", "expected"),
    [(-1, AccountType.LIABILITY), (0, AccountType.ASSET), (1, AccountType.ASSET)],
)
def test_overdraft_reporting_type_changes_only_below_zero(raw_balance, expected):
    account = Account(
        name="카오뱅크",
        type=AccountType.ASSET,
        is_overdraft=True,
    )
    assert reporting_type(account, raw_balance) == expected


def test_ordinary_negative_asset_keeps_asset_reporting_type():
    account = Account(name="현금", type=AccountType.ASSET)
    assert reporting_type(account, -1) == AccountType.ASSET


@pytest.mark.parametrize(
    "account",
    [
        Account(name="대출", type=AccountType.LIABILITY, is_overdraft=True),
        Account(name="시스템", type=AccountType.ASSET, is_system=True, is_overdraft=True),
        Account(name="그룹", type=AccountType.ASSET, is_placeholder=True, is_overdraft=True),
    ],
)
def test_overdraft_shape_rejects_non_leaf_asset_shapes(account):
    with pytest.raises(DomainValidationError) as exc_info:
        validate_overdraft_shape(account)
    assert exc_info.value.code == "overdraft_invalid_account"


def test_overdraft_transition_rejects_child_and_archived_accounts(repo):
    parent = repo.save(Account(name="입출금", type=AccountType.ASSET))
    repo.save(Account(name="토스뱅크", type=AccountType.ASSET, parent_id=parent.id))

    with pytest.raises(DomainConflictError) as child_error:
        validate_overdraft_transition(
            parent,
            parent.model_copy(update={"is_overdraft": True}),
            repo,
        )
    assert child_error.value.code == "overdraft_requires_leaf"

    archived = Account(
        id=99,
        name="보관 계정",
        type=AccountType.ASSET,
        archived=True,
    )
    with pytest.raises(DomainConflictError) as archived_error:
        validate_overdraft_transition(
            archived,
            archived.model_copy(update={"is_overdraft": True}),
            repo,
        )
    assert archived_error.value.code == "archived_account_read_only"


@pytest.mark.parametrize(
    ("account", "state", "expected"),
    [
        (Account(name="현금", type=AccountType.ASSET), "positive", 1000),
        (
            Account(name="마통", type=AccountType.ASSET, is_overdraft=True),
            "positive",
            1000,
        ),
        (
            Account(name="마통", type=AccountType.ASSET, is_overdraft=True),
            "negative",
            -1000,
        ),
        (Account(name="대출", type=AccountType.LIABILITY), "negative", -1000),
    ],
)
def test_opening_balance_posting_sign(account, state, expected):
    assert opening_balance_posting_amount(
        account,
        1000,
        state,
        has_children=False,
    ) == expected


@pytest.mark.parametrize(
    ("account", "amount", "state", "code"),
    [
        (
            Account(name="현금", type=AccountType.ASSET),
            1000,
            "negative",
            "negative_opening_requires_overdraft",
        ),
        (
            Account(name="대출", type=AccountType.LIABILITY),
            1000,
            "positive",
            "invalid_opening_state",
        ),
        (
            Account(name="급여", type=AccountType.INCOME),
            1000,
            "positive",
            "opening_invalid_account",
        ),
        (
            Account(name="현금", type=AccountType.ASSET),
            0,
            "positive",
            "invalid_opening_amount",
        ),
        (
            Account(name="현금", type=AccountType.ASSET),
            1000,
            "unknown",
            "invalid_opening_state",
        ),
    ],
)
def test_opening_balance_rejects_invalid_combinations(account, amount, state, code):
    with pytest.raises(DomainValidationError) as exc_info:
        opening_balance_posting_amount(
            account,
            amount,
            state,
            has_children=False,
        )
    assert exc_info.value.code == code
