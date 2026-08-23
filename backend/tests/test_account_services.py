import pytest

from moneymap.domain import (
    Account,
    AccountType,
    DomainValidationError,
    reporting_type,
)
from moneymap.domain.services import (
    opening_balance_posting_amount,
)


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
