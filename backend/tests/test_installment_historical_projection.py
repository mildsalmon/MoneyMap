"""Purchases after a scenario fork cannot consume its bill coverage."""

import datetime as dt

import test_api
from test_installments import (
    TODAY,
    allocate,
    envelope,
    plans,
    purchase,
    setup,
    transaction,
)

client = test_api.client


def test_later_purchase_does_not_invalidate_historical_bill_coverage(client):
    accounts = setup(client)
    fork = TODAY - dt.timedelta(days=5)
    due = TODAY + dt.timedelta(days=1)
    first, _ = purchase(
        client, accounts, date=fork.isoformat(), first_due_date=due.isoformat()
    )
    response = client.post(
        "/api/rules",
        json=dict(
            description="카드 청구액",
            from_account_id=accounts["cash"],
            to_account_id=accounts["card"],
            amount=200_000,
            schedule=f"monthly:{due.day}",
            start_date=due.isoformat(),
        ),
    )
    assert response.status_code == 201, response.text

    def include(plan_id):
        plan = next(p for p in plans(client) if p["id"] == plan_id)
        response = client.put(
            f"/api/installments/{plan_id}",
            json=envelope(
                client,
                projection_mode="included",
                rule_signature=plan["current_rule_signature"],
            ),
        )
        assert response.status_code == 200, response.text

    include(first["id"])
    # The old purchase is paid off after the historical fork, freeing bill capacity
    # today for a new purchase. At the fork only the old purchase exists and is due.
    payment = transaction(client, accounts["card"], accounts["cash"], 1_200_000)
    rows = plans(client)[0]["installments"]
    response = allocate(client, payment, [(r["id"], r["principal"]) for r in rows])
    assert response.status_code == 200, response.text
    later, _ = purchase(client, accounts, first_due_date=due.isoformat())
    include(later["id"])

    response = client.post(
        "/api/scenarios",
        json=dict(name="과거 할부 전망", description="", fork_date=fork.isoformat()),
    )
    assert response.status_code == 201, response.text
    scenario_id = response.json()["scenario"]["id"]
    response = client.get(f"/api/projection?scenario_id={scenario_id}&months=12")
    assert response.status_code == 200, response.text
    assert response.json()["warnings"] == []
