import pytest

from moneymap.domain import Money, MixedCurrencyError


def test_same_currency_arithmetic():
    a = Money(amount=1000)
    b = Money(amount=500)
    assert (a + b).amount == 1500
    assert (a - b).amount == 500
    assert (-a).amount == -1000
    assert (a + b).currency == "KRW"


def test_mixed_currency_rejected():
    krw = Money(amount=1000, currency="KRW")
    usd = Money(amount=1000, currency="USD")
    with pytest.raises(MixedCurrencyError):
        _ = krw + usd
    with pytest.raises(MixedCurrencyError):
        _ = krw - usd


def test_currency_normalized_to_upper():
    assert Money(amount=1, currency="krw").currency == "KRW"


def test_money_is_immutable():
    m = Money(amount=1000)
    with pytest.raises(Exception):
        m.amount = 2000  # type: ignore[misc]
