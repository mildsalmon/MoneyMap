import pytest

from moneymap.domain import Account, AccountCycleError, AccountType, DomainError
from moneymap.domain.services import validate_account_placement


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
