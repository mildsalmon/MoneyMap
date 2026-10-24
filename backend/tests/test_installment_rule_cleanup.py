"""Deleting a bill rule preserves its confirmed installment payment."""

import sqlite3
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect
from moneymap.adapters.sqlite import database
from moneymap.api import create_app
from test_installments import TODAY, allocate, plans, purchase, setup
import test_api

client = test_api.client


def test_v7_upgrade_preserves_linked_allocation_and_allows_rule_cleanup(tmp_path):
    path = str(tmp_path / "v7-installments.db")
    tables = ("transactions", "postings", "installment_plans", "installments",
              "installment_allocations", "installment_requests")

    def snapshot():
        conn = connect(path)
        try:
            return {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
                    for table in tables}
        finally:
            conn.close()

    with patch.object(database, "MIGRATIONS", database.MIGRATIONS[:7]):
        with TestClient(create_app(path)) as old:
            accounts = setup(old)
            purchase(old, accounts)
            rule = old.post("/api/rules", json={
                "description": "card bill", "from_account_id": accounts["cash"],
                "to_account_id": accounts["card"], "amount": 200_000,
                "schedule": f"monthly:{TODAY.day}", "start_date": TODAY.isoformat(),
            }).json()
            payment_id = old.post("/api/materialize").json()["transactions"][0]["id"]
            row_id = plans(old)[0]["installments"][0]["id"]
            assert allocate(old, payment_id, [(row_id, 200_000)]).status_code == 200
            assert old.delete(f"/api/rules/{rule['id']}").status_code == 409
            before = snapshot()

    with TestClient(create_app(path)) as upgraded:
        assert snapshot() == before
        conn = connect(path)
        try:
            assert conn.execute("PRAGMA user_version").fetchone()[0] == 8
            assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        finally:
            conn.close()
        response = upgraded.delete(f"/api/rules/{rule['id']}")
        assert response.status_code == 200, response.text
        after = snapshot()
        for table in tables[1:]:
            assert after[table] == before[table]
        assert upgraded.get(f"/api/transactions/{payment_id}").json()["source_rule_id"] is None
        assert upgraded.delete(f"/api/transactions/{payment_id}").status_code == 409
    with TestClient(create_app(path)):
        assert snapshot() == after


def test_delete_materialized_bill_rule_keeps_linked_payment_locked(client):
    accounts = setup(client)
    created, _ = purchase(client, accounts)
    rule = client.post("/api/rules", json={
        "description": "card bill",
        "from_account_id": accounts["cash"],
        "to_account_id": accounts["card"],
        "amount": 200_000,
        "schedule": f"monthly:{TODAY.day}",
        "start_date": TODAY.isoformat(),
    })
    assert rule.status_code == 201, rule.text
    materialized = client.post("/api/materialize")
    assert materialized.status_code == 200, materialized.text
    payment_id = materialized.json()["transactions"][0]["id"]
    row_id = plans(client)[0]["installments"][0]["id"]
    assert allocate(client, payment_id, [(row_id, 200_000)]).status_code == 200
    purchase_before = client.get(f"/api/transactions/{created['purchase_id']}").json()
    payment_before = client.get(f"/api/transactions/{payment_id}").json()
    allocations_before = plans(client)[0]["allocations"]

    conn = connect(client.app.state.db_path)
    try:
        for field, value in (("memo", "tampered"), ("edit_version", "0" * 32),
                             ("entry_origin", "user"), ("id", payment_id + 1000)):
            with pytest.raises(sqlite3.IntegrityError, match="installment_transaction_linked"):
                conn.execute(
                    f"UPDATE transactions SET source_rule_id=NULL,{field}=? WHERE id=?",
                    (value, payment_id),
                )
            conn.rollback()
    finally:
        conn.close()

    deleted = client.delete(f"/api/rules/{rule.json()['id']}")
    assert deleted.status_code == 200, deleted.text
    assert client.get("/api/rules").json() == []
    assert client.get(f"/api/transactions/{created['purchase_id']}").json() == purchase_before
    payment = client.get(f"/api/transactions/{payment_id}").json()
    assert payment == {**payment_before, "source_rule_id": None}
    assert plans(client)[0]["allocations"] == allocations_before

    for transaction_id in (created["purchase_id"], payment_id):
        detail = client.get(f"/api/transactions/{transaction_id}").json()
        command = {
            "request_id": str(uuid.uuid4()), "expected_version": detail["version"],
            "date": detail["date"], "description": "changed", "memo": "",
            "tags": [], "postings": [
                {key: posting[key] for key in ("posting_id", "account_id", "amount")}
                for posting in detail["postings"]
            ],
        }
        assert client.put(f"/api/transactions/{transaction_id}", json=command).status_code == 409
        assert client.delete(f"/api/transactions/{transaction_id}").status_code == 409

    conn = connect(client.app.state.db_path)
    try:
        for field, value in (("memo", "tampered"), ("edit_version", "0" * 32),
                             ("entry_origin", "user"), ("id", payment_id + 1000)):
            with pytest.raises(sqlite3.IntegrityError, match="installment_transaction_linked"):
                conn.execute(f"UPDATE transactions SET {field}=? WHERE id=?", (value, payment_id))
            conn.rollback()
    finally:
        conn.close()
