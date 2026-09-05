"""Actual-only mutations recheck ownership after obtaining the writer lock."""

import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from moneymap.api import create_app
from moneymap.adapters.sqlite import connect
from moneymap.adapters.sqlite.rules import SqliteRecurringRuleRepository
from moneymap.adapters.sqlite.transactions import SqliteTransactionRepository
from moneymap.adapters.sqlite.uow import SqliteUnitOfWork
from moneymap.domain import Money, Posting, Transaction


@pytest.fixture
def ledger(tmp_path):
    with TestClient(create_app(str(tmp_path / "ownership.db"))) as client:
        cash = client.post(
            "/api/accounts", json={"name": "cash", "type": "asset"}
        ).json()["id"]
        income = client.post(
            "/api/accounts", json={"name": "income", "type": "income"}
        ).json()["id"]
        sid = client.post(
            "/api/scenarios", json={"name": "plan", "fork_date": "2026-01-31"}
        ).json()["scenario"]["id"]
        yield client, cash, income, sid


def snapshot(conn):
    return {
        table: [
            tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY id")
        ]
        for table in (
            "scenarios",
            "recurring_rules",
            "transactions",
            "postings",
            "calculation_revisions",
        )
    }


def pause_first(monkeypatch, owner, method):
    entered, release = Barrier(2), Barrier(2)
    original = getattr(owner, method)
    first = True

    def paused(*args, **kwargs):
        nonlocal first
        if first:
            first = False
            entered.wait(timeout=5)
            release.wait(timeout=5)
        return original(*args, **kwargs)

    monkeypatch.setattr(owner, method, paused)
    return entered, release


@pytest.mark.parametrize("method", ["put", "delete"])
def test_actual_rule_request_cannot_mutate_replacement_scenario_rule(
    ledger, monkeypatch, method
):
    client, cash, income, sid = ledger
    body = {
        "from_account_id": income,
        "to_account_id": cash,
        "amount": 100,
        "schedule": "monthly:1",
        "start_date": "2026-01-01",
    }
    rid = client.post("/api/rules", json=body).json()["id"]
    entered, release = pause_first(
        monkeypatch,
        SqliteRecurringRuleRepository,
        "save" if method == "put" else "delete",
    )
    conn = connect(client.app.state.db_path)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(
                client.request,
                method,
                f"/api/rules/{rid}",
                json={**body, "amount": 999} if method == "put" else None,
            )
            entered.wait(timeout=5)
            try:
                assert client.delete(f"/api/rules/{rid}").status_code == 200
                replacement = client.post(
                    f"/api/scenarios/{sid}/rules", json={**body, "scenario_version": 1}
                ).json()
                assert replacement["rule"]["id"] == rid
                assert (
                    client.post(
                        f"/api/scenarios/{sid}/archive", json={"version": 2}
                    ).status_code
                    == 200
                )
                before = snapshot(conn)
            finally:
                release.wait(timeout=5)
            result = pending.result(timeout=5)
        assert result.status_code == 404
        assert result.json()["detail"]["code"] == "rule_not_found"
        assert snapshot(conn) == before
    finally:
        conn.close()


def test_actual_transaction_delete_cannot_remove_replacement_scenario_transaction(
    ledger, monkeypatch
):
    client, cash, income, sid = ledger
    body = {
        "date": "2026-02-01",
        "postings": [
            {"account_id": cash, "amount": 100},
            {"account_id": income, "amount": -100},
        ],
    }
    tid = client.post("/api/transactions", json=body).json()["id"]
    entered, release = pause_first(monkeypatch, SqliteTransactionRepository, "delete")
    conn = connect(client.app.state.db_path)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(client.delete, f"/api/transactions/{tid}")
            entered.wait(timeout=5)
            try:
                assert client.delete(f"/api/transactions/{tid}").status_code == 200
                with SqliteUnitOfWork(conn) as uow:
                    replacement = uow.transactions.save(
                        Transaction(
                            scenario_id=sid,
                            date=dt.date(2026, 2, 1),
                            postings=[
                                Posting(account_id=cash, amount=Money(amount=200)),
                                Posting(account_id=income, amount=Money(amount=-200)),
                            ],
                        )
                    )
                assert replacement.id == tid
                assert (
                    client.post(
                        f"/api/scenarios/{sid}/archive", json={"version": 1}
                    ).status_code
                    == 200
                )
                before = snapshot(conn)
            finally:
                release.wait(timeout=5)
            result = pending.result(timeout=5)
        assert result.status_code == 404
        assert result.json()["detail"]["code"] == "transaction_not_found"
        assert snapshot(conn) == before
    finally:
        conn.close()


@pytest.mark.parametrize("invalid", ["same_accounts", "end_before_start"])
def test_actual_rule_put_validates_whole_model_without_mutation(ledger, invalid):
    client, cash, income, _ = ledger
    body = {
        "from_account_id": income,
        "to_account_id": cash,
        "amount": 100,
        "schedule": "monthly:1",
        "start_date": "2026-01-01",
    }
    created = client.post("/api/rules", json=body)
    assert created.status_code == 201
    rid = created.json()["id"]
    update = {
        **body,
        **(
            {"to_account_id": income}
            if invalid == "same_accounts"
            else {"end_date": "2025-12-31"}
        ),
    }
    conn = connect(client.app.state.db_path)
    try:
        before = snapshot(conn)
        result = client.put(f"/api/rules/{rid}", json=update)
        assert result.status_code == 400, result.text
        assert result.json()["detail"]["code"] == "validation_error"
        assert snapshot(conn) == before
        assert client.get("/api/rules").json() == [created.json()]
    finally:
        conn.close()
