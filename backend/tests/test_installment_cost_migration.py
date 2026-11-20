"""Upgrade released principal-only data and the v14 account creation receipt."""

from contextlib import contextmanager
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, database
from moneymap.api import create_app
from test_installments import TODAY, setup, transaction


@contextmanager
def installed_app(path, version):
    with patch.object(database, "MIGRATIONS", database.MIGRATIONS[:version]):
        with TestClient(create_app(str(path))) as client:
            yield client


def seed_principal_only(path, client):
    a = setup(client)
    cash = next(
        item for item in client.get("/api/accounts").json() if item["id"] == a["cash"]
    )
    response = client.put(
        f"/api/accounts/{cash['id']}/settings",
        json=dict(
            name=cash["name"],
            parent_id=None,
            is_overdraft=False,
            version=cash["version"],
            include_in_cash=True,
        ),
    )
    assert response.is_success
    purchase = transaction(client, a["expense"], a["card"], 20_001)
    payment = transaction(client, a["card"], a["cash"], 5_000)
    with connect(str(path)) as conn:
        plan = conn.execute(
            """INSERT INTO installment_plans(purchase_id,debit_account_id,card_account_id,
            cash_account_id,principal) VALUES(?,?,?,?,20001)""",
            (purchase, a["expense"], a["card"], a["cash"]),
        ).lastrowid
        rows = []
        for number, days, principal in [(1, 5, 10000), (2, 35, 10001)]:
            rows.append(
                conn.execute(
                    "INSERT INTO installments(plan_id,number,due_date,principal) VALUES(?,?,?,?)",
                    (
                        plan,
                        number,
                        (TODAY + timedelta(days=days)).isoformat(),
                        principal,
                    ),
                ).lastrowid
            )
        conn.execute(
            "INSERT INTO installment_allocations VALUES(?,?,'payment',5000)",
            (payment, rows[0]),
        )
    return a, payment, rows


def legacy_rows(path):
    with connect(str(path)) as conn:
        return {
            name: [
                tuple(row)
                for row in conn.execute(f"SELECT {fields} FROM {name} ORDER BY rowid")
            ]
            for name, fields in [
                ("transactions", "*"),
                ("postings", "*"),
                ("installments", "*"),
                (
                    "installment_allocations",
                    "transaction_id,installment_id,kind,amount",
                ),
                ("installment_requests", "*"),
            ]
        }


@pytest.mark.parametrize(
    "versions",
    [(13, 15), (13, 14, 15), (14, 15)],
    ids=["v13-direct", "v13-v14-v15", "installed-v14"],
)
def test_interest_free_ledger_and_account_receipts_survive(versions, tmp_path):
    path = tmp_path / "synthetic.db"
    command = dict(name="합성 계정 생성 영수증", type="asset", request_id=str(uuid4()))
    receipt_path = f"/api/accounts/creation-requests/{command['request_id']}"
    saved_id = None
    for index, version in enumerate(versions):
        with installed_app(path, version) as client:
            with connect(str(path)) as conn:
                assert conn.execute("PRAGMA user_version").fetchone()[0] == version
            if index == 0:
                a, payment, rows = seed_principal_only(path, client)
                ledger = legacy_rows(path)
                transactions = client.get("/api/transactions").json()
            if version == 14:
                saved_id = client.post("/api/accounts", json=command).json()["id"]
                with connect(str(path)) as conn:
                    receipt = tuple(
                        conn.execute(
                            "SELECT * FROM account_creation_requests"
                        ).fetchone()
                    )
            if version == 15:
                with connect(str(path)) as conn:
                    if saved_id is not None:
                        assert (
                            tuple(
                                conn.execute(
                                    "SELECT * FROM account_creation_requests"
                                ).fetchone()
                            )
                            == receipt
                        )
                    else:
                        assert (
                            conn.execute(
                                "SELECT count(*) FROM account_creation_requests"
                            ).fetchone()[0]
                            == 0
                        )
                    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
                if saved_id is None:
                    saved_id = client.post("/api/accounts", json=command).json()["id"]
                assert client.get(receipt_path).json()["id"] == saved_id
                assert (
                    client.post("/api/accounts", json=command).json()["id"] == saved_id
                )
                assert (
                    client.post(
                        "/api/accounts", json=command | {"name": "다른 계정"}
                    ).status_code
                    == 409
                )
                assert legacy_rows(path) == ledger
                assert client.get("/api/transactions").json() == transactions
                plan = client.get("/api/installments").json()["plans"][0]
                assert [
                    (r["id"], r["principal"], r["remaining"], r["unpaid_total"])
                    for r in plan["installments"]
                ] == [(rows[0], 10000, 5000, 5000), (rows[1], 10001, 10001, 10001)]
                assert [
                    (
                        entry["transaction_id"],
                        entry["amount"],
                        entry["interest"],
                        entry["fee"],
                    )
                    for entry in plan["allocations"]
                ] == [(payment, 5000, 0, 0)]
                curve = client.get("/api/projection?scenario_id=1&months=3").json()
                for target in ("baseline", "scenario"):
                    cash = curve["cash"][target]["points"]
                    assert cash[0]["balance"] == -5000
                    assert cash[-1]["balance"] == -20001
                    assert all(
                        p["balance"] == -20001
                        for p in curve["net_worth"][target]["points"]
                    )
                    assert all(
                        not m[target]["expense"]
                        for m in curve["monthly_income_expense"]
                    )
                assert not curve["warnings"]
