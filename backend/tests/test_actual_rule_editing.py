"""Snapshot-safe actual rule editing, independent of the machine's date."""
import datetime
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from moneymap.api import create_app
from moneymap.adapters.sqlite import connect
from moneymap.routers import rules as router


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "rules.db"))) as c:
        yield c


def create_rule(client, **changes):
    ids = [client.post("/api/accounts", json={"name": name, "type": kind}).json()["id"]
           for name, kind in [("급여", "income"), ("통장", "asset")]]
    body = dict(description="월급", from_account_id=ids[0], to_account_id=ids[1],
                amount=100, schedule="monthly:31", start_date="2024-01-01", end_date=None)
    body.update(changes)
    res = client.post("/api/rules", json=body)
    assert res.status_code == 201
    return res.json(), body


def edit(client, rule, body):
    return client.put(f"/api/rules/{rule['id']}", json=body,
                      headers={"If-Match": rule["edit_token"]})


def at(monkeypatch, date):
    monkeypatch.setattr(router, "now", lambda: datetime.datetime.fromisoformat(date))


def test_original_transactions_and_watermark_survive_new_month_end_conditions(client, monkeypatch):
    rule, body = create_rule(client)
    at(monkeypatch, "2024-01-31")
    assert client.post("/api/materialize").json()["created"] == 1
    before = client.get("/api/transactions").json()
    current = client.get("/api/rules").json()[0]
    updated = edit(client, current, {**body, "amount": 250, "start_date": "2024-01-10", "end_date": "2024-03-31"})
    assert updated.status_code == 200
    assert updated.json()["last_materialized"] == "2024-01-31"
    assert updated.json()["id"] == rule["id"]
    assert client.get("/api/transactions").json() == before
    # Editing itself never materializes. Pending past February uses the NEW amount.
    at(monkeypatch, "2024-04-30")
    generated = client.post("/api/materialize").json()
    assert [t["date"] for t in generated["transactions"]] == ["2024-02-29", "2024-03-31"]
    txns = client.get("/api/transactions").json()
    assert next(t for t in txns if t["id"] == before[0]["id"]) == before[0]
    assert all(t["source_rule_id"] == rule["id"] for t in txns)
    assert [abs(t["postings"][0]["amount"]["amount"]) for t in txns] == [100, 250, 250]
    assert client.post("/api/materialize").json()["created"] == 0


def test_edit_weekly_schedule_date_window_and_null_end(client, monkeypatch):
    rule, body = create_rule(client)
    res = edit(client, rule, {**body, "schedule": "weekly:mon", "start_date": "2024-02-05", "end_date": "2024-02-12"})
    assert res.status_code == 200
    at(monkeypatch, "2024-02-20")
    assert [t["date"] for t in client.post("/api/materialize").json()["transactions"]] == ["2024-02-05", "2024-02-12"]
    current = client.get("/api/rules").json()[0]
    res = edit(client, current, {**body, "schedule": "weekly:mon", "start_date": "2024-02-05", "end_date": None})
    assert res.json()["end_date"] is None
    assert [t["date"] for t in client.post("/api/materialize").json()["transactions"]] == ["2024-02-19"]


def test_missing_and_stale_preconditions_do_not_overwrite(client, monkeypatch):
    rule, body = create_rule(client)
    assert client.put(f"/api/rules/{rule['id']}", json=body).status_code == 428
    first = edit(client, rule, {**body, "amount": 200})
    assert first.status_code == 200
    assert edit(client, rule, {**body, "amount": 300}).status_code == 409
    # Includes watermark even when no occurrence was generated.
    at(monkeypatch, "2024-01-02")
    assert client.post("/api/materialize").json()["created"] == 0
    assert edit(client, first.json(), body).status_code == 409
    current = client.get("/api/rules").json()[0]
    assert current["amount"]["amount"] == 200
    assert current["last_materialized"] == "2024-01-02"


def test_two_concurrent_edits_only_one_wins(client):
    rule, body = create_rule(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda amount: edit(client, rule, {**body, "amount": amount}), [200, 300]))
    assert sorted(r.status_code for r in results) == [200, 409]
    winner = next(r.json() for r in results if r.status_code == 200)
    assert client.get("/api/rules").json()[0] == winner


@pytest.mark.parametrize("changes", [
    {"amount": 0}, {"amount": -1}, {"amount": 1.5}, {"schedule": "monthly:32"},
    {"schedule": "weekly:bad"}, {"end_date": "2023-12-31"},
    {"from_account_id": 99999},
])
def test_invalid_edits_leave_rule_unchanged(client, changes):
    rule, body = create_rule(client)
    response = edit(client, rule, {**body, **changes})
    assert response.status_code in (400, 404, 422)
    assert client.get("/api/rules").json()[0] == rule


def test_non_krw_rule_is_not_silently_converted(client):
    rule, body = create_rule(client)
    conn = connect(client.app.state.db_path)
    try:
        conn.execute("UPDATE recurring_rules SET currency='USD' WHERE id=?", (rule["id"],))
        conn.commit()
    finally:
        conn.close()
    current = client.get("/api/rules").json()[0]
    response = edit(client, current, body)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "unsupported_rule_currency"
    assert client.get("/api/rules").json()[0] == current


@pytest.mark.parametrize("unavailable", ["archived", "currency", "group"])
def test_unavailable_account_cannot_replace_rule_target(client, unavailable):
    rule, body = create_rule(client)
    target = client.post("/api/accounts", json={"name": "사용불가", "type": "asset"}).json()["id"]
    if unavailable == "archived":
        assert client.post(f"/api/accounts/{target}/archive").status_code == 200
    elif unavailable == "group":
        assert client.post(f"/api/accounts/{target}/placeholder", json={"is_placeholder": True}).status_code == 200
    else:
        conn = connect(client.app.state.db_path)
        try:
            conn.execute("UPDATE accounts SET currency='USD' WHERE id=?", (target,))
            conn.commit()
        finally:
            conn.close()
    result = edit(client, rule, {**body, "to_account_id": target})
    assert result.status_code == 400
    assert client.get("/api/rules").json()[0] == rule
