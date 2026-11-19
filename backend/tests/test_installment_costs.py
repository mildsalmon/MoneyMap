"""Synthetic statements, original expense postings, and historical cash forecasts."""

import datetime as dt

import test_api
from test_installments import (
    TODAY,
    balance,
    envelope,
    plans,
    purchase,
    setup,
    transaction,
)

client = test_api.client


def statement_purchase(client, **changes):
    accounts = setup(client)
    for component in ("interest", "fee"):
        accounts[component] = test_api.make_account(client, component, "expense")
    due = TODAY + dt.timedelta(days=1)
    args = dict(
        principal=20_000,
        months=2,
        first_due_date=due.isoformat(),
        interest_account_id=accounts["interest"],
        fee_account_id=accounts["fee"],
        statement=[
            dict(principal=10_000, interest=600, fee=100),
            dict(principal=10_000, interest=400, fee=0),
        ],
    )
    purchase(client, accounts, **(args | changes))
    return accounts, plans(client)[0]["installments"][0]["id"]


def connect_split(client, txn, kind, allocations):
    return client.put(
        "/api/installments/allocations",
        json=envelope(client, transaction_id=txn, kind=kind, allocations=allocations),
    )


def split(client, txn, kind, row, **amounts):
    return connect_split(
        client, txn, kind, [dict(installment_id=row, amount=0) | amounts]
    )


def forecast(client, sid=1):
    response = client.get(f"/api/projection?scenario_id={sid}&months=3")
    assert response.is_success, response.text
    return response.json()


def expense(curve, path):
    return sum(month[path]["expense"] for month in curve["monthly_income_expense"])


def test_prebooked_charge_reused_once_and_cannot_be_unlinked_before_payment(client):
    a, row = statement_purchase(client)
    tid = transaction(client, a["interest"], a["card"], 600)
    assert split(client, tid, "charge", row, interest=600).is_success
    paid = transaction(client, a["card"], a["cash"], 5_600)
    assert split(
        client,
        paid,
        "billed_payment",
        row,
        amount=5000,
        interest=600,
        interest_charge_id=tid,
    ).is_success
    assert balance(client, a["interest"]) == 600
    first = plans(client)[0]["installments"][0]
    assert (first["remaining"], first["remaining_interest"], first["unpaid_total"]) == (
        5000,
        0,
        5100,
    )
    assert connect_split(client, tid, "payment", []).status_code == 400
    assert (
        split(
            client, paid, "billed_payment", row, interest=601, interest_charge_id=tid
        ).status_code
        == 400
    )
    assert (
        split(
            client, paid, "billed_payment", row, interest=1, interest_charge_id=paid
        ).status_code
        == 400
    )
    assert (
        split(client, paid, "payment", row, amount=4999, interest=601).status_code
        == 400
    )
    assert plans(client)[0]["installments"][0] == first
    assert expense(forecast(client), "baseline") == 500
    assert connect_split(client, paid, "payment", []).is_success
    reversal = transaction(client, a["card"], a["interest"], 200)
    assert split(
        client, reversal, "charge_refund", row, interest=200, interest_charge_id=tid
    ).is_success
    assert plans(client)[0]["installments"][0]["unpaid_total"] == 10_500
    assert balance(client, a["interest"]) == 400
    assert (
        split(
            client, paid, "billed_payment", row, interest=401, interest_charge_id=tid
        ).status_code
        == 400
    )
    assert split(
        client, paid, "billed_payment", row, interest=400, interest_charge_id=tid
    ).is_success
    assert client.delete(f"/api/transactions/{tid}").status_code == 409


def test_historical_statement_replacement_and_future_interest_cancellation(client):
    prior = TODAY - dt.timedelta(days=1)
    a, row = statement_purchase(client, date=prior.isoformat())
    assert test_api.update_settings(client, a["cash"], include_in_cash=True).is_success
    scenario = client.post(
        "/api/scenarios",
        json=dict(name="명세서 기준", description="", fork_date=prior.isoformat()),
    )
    sid = scenario.json()["scenario"]["id"]

    def edit(**values):
        return client.put(
            f"/api/installments/rows/{row}/statement",
            json=envelope(client, effective_date=TODAY.isoformat(), **values),
        )

    assert edit(interest=600, fee=100, cancelled_interest=600, early_fee=80).is_success
    prepaid = transaction(client, a["fee"], a["cash"], 180)
    assert split(client, prepaid, "payment", row, fee=180).is_success
    assert (
        edit(interest=600, fee=100, cancelled_interest=600, early_fee=79).status_code
        == 400
    )
    assert (
        edit(interest=600, fee=100, cancelled_interest=601, early_fee=80).status_code
        == 422
    )
    for projection, cash, future_cost in [
        (forecast(client), -20580, 400),
        (forecast(client, sid), -21100, 1100),
    ]:
        for path in ("baseline", "scenario"):
            assert projection["cash"][path]["points"][-1]["balance"] == cash
            assert expense(projection, path) == future_cost


def test_rule_covers_principal_plus_cost_and_reclassifies_expense_once(client):
    a, row = statement_purchase(client)
    due = TODAY + dt.timedelta(days=1)
    assert test_api.update_settings(client, a["cash"], include_in_cash=True).is_success

    def bill(amount):
        response = client.post(
            "/api/rules",
            json=dict(
                description="합성 명세서 카드값",
                from_account_id=a["cash"],
                to_account_id=a["card"],
                amount=amount,
                schedule=f"monthly:{due.day}",
                start_date=due.isoformat(),
            ),
        )
        assert response.is_success
        return response.json()["id"]

    insufficient = bill(10_000)

    def include():
        p = plans(client)[0]
        return client.put(
            f"/api/installments/{p['id']}",
            json=envelope(
                client,
                projection_mode="included",
                rule_signature=p["current_rule_signature"],
            ),
        )

    assert include().status_code == 400
    assert client.delete(f"/api/rules/{insufficient}").is_success
    bill(10_700)
    assert include().is_success
    sid = client.post(
        "/api/scenarios",
        json=dict(name="예정 카드값", description="", fork_date=TODAY.isoformat()),
    ).json()["scenario"]["id"]
    for projection in (forecast(client), forecast(client, sid)):
        for path in ("baseline", "scenario"):
            assert all(
                (p["balance"] % 10_700) == 0 for p in projection["cash"][path]["points"]
            )
            assert expense(projection, path) == 1100
            assert projection["net_worth"][path]["points"][-1]["balance"] == -21_100


def test_unknown_costs_and_invalid_account_or_component(client):
    a, row = statement_purchase(
        client,
        statement=[
            dict(principal=9_000, interest=None, fee=0),
            dict(principal=11_000, interest=0, fee=None),
        ],
    )
    first = plans(client)[0]["installments"][0]
    assert first["unknown_cost"] and first["unpaid_total"] == 9000
    assert any("미확인 이자" in w for w in forecast(client)["warnings"])
    tid = transaction(client, a["interest"], a["cash"], 1)
    assert split(client, tid, "payment", row, interest=1).status_code == 400
    assert client.post(f"/api/accounts/{a['interest']}/archive").status_code == 409
    assert split(client, tid, "charge", row, amount=1).status_code == 400
    assert split(client, tid, "payment", row, amount=0).status_code == 422


def test_scenario_only_bill_holds_overlapping_statement_only_in_that_scenario(client):
    a, _ = statement_purchase(client)
    assert test_api.update_settings(client, a["cash"], include_in_cash=True).is_success
    scenario = client.post(
        "/api/scenarios",
        json=dict(name="합성 카드 가정", description="", fork_date=TODAY.isoformat()),
    ).json()["scenario"]
    due = TODAY + dt.timedelta(days=1)
    response = client.post(
        f"/api/scenarios/{scenario['id']}/rules",
        json=dict(
            scenario_version=scenario["version"],
            description="첫 회차 포함 가능",
            from_account_id=a["cash"],
            to_account_id=a["card"],
            amount=11_000,
            schedule=f"monthly:{due.day}",
            start_date=due.isoformat(),
            end_date=due.isoformat(),
        ),
    )
    assert response.is_success, response.text
    data = forecast(client, scenario["id"])
    assert data["cash"]["baseline"]["points"][-1]["balance"] == -21_100
    assert data["cash"]["scenario"]["points"][-1]["balance"] == -21_400
    assert any("시나리오 카드값" in w for w in data["warnings"])


def test_one_payment_can_clear_prebooked_interest_and_direct_fee(client):
    a, row = statement_purchase(client)
    charge = transaction(client, a["interest"], a["card"], 600)
    assert split(client, charge, "charge", row, interest=600).is_success
    paid = transaction(
        client,
        a["card"],
        a["cash"],
        5700,
        postings=[
            dict(account_id=a["card"], amount=5600),
            dict(account_id=a["fee"], amount=100),
            dict(account_id=a["cash"], amount=-5700),
        ],
    )
    assert split(
        client,
        paid,
        "billed_payment",
        row,
        amount=5000,
        interest=600,
        fee=100,
        interest_charge_id=charge,
    ).is_success
    assert plans(client)[0]["installments"][0]["unpaid_total"] == 5000
    assert balance(client, a["interest"]) == 600 and balance(client, a["fee"]) == 100


def test_statement_is_unknown_before_first_confirmation(client):
    prior = TODAY - dt.timedelta(days=1)
    statement_purchase(client, date=prior.isoformat(), statement_date=TODAY.isoformat())
    sid = client.post(
        "/api/scenarios",
        json=dict(name="확정 전", description="", fork_date=prior.isoformat()),
    ).json()["scenario"]["id"]
    data = forecast(client, sid)
    assert expense(data, "scenario") == 0 and any(
        "미확인 이자" in w for w in data["warnings"]
    )
    assert expense(forecast(client), "baseline") == 1100
