"""Finite schedules and actual-ledger integration, with hand-calculated assertions."""

import datetime as dt
import uuid
from unittest.mock import patch

import pytest

import test_api
from test_api import make_account

from moneymap.domain.installments import schedule
from moneymap.app_services.scenarios import now

client = test_api.client

TODAY = now().date()


def envelope(client, **body):
    return dict(
        request_id=str(uuid.uuid4()),
        expected_revision=client.get("/api/installments").json()["revision"],
        **body,
    )


def setup(client):
    return {
        name: make_account(client, f"할부 {name}", kind)
        for name, kind in [
            ("expense", "expense"),
            ("card", "liability"),
            ("cash", "asset"),
        ]
    }


def purchase(client, accounts, **changes):
    body = envelope(
        client,
        description="노트북",
        date=TODAY.isoformat(),
        debit_account_id=accounts["expense"],
        card_account_id=accounts["card"],
        cash_account_id=accounts["cash"],
        principal=1_200_000,
        months=6,
        first_due_date=TODAY.isoformat(),
    )
    body.update(changes)
    response = client.post("/api/installments", json=body)
    assert response.status_code == 201, response.text
    return response.json(), body


def plans(client):
    return client.get("/api/installments").json()["plans"]


def transaction(client, debit, credit, amount, **changes):
    body = dict(
        date=TODAY.isoformat(),
        description="카드 납부",
        postings=[
            {"account_id": debit, "amount": amount},
            {"account_id": credit, "amount": -amount},
        ],
    )
    body.update(changes)
    response = client.post("/api/transactions", json=body)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def allocate(client, txn, rows, kind="payment"):
    return client.put(
        "/api/installments/allocations",
        json=envelope(
            client,
            transaction_id=txn,
            kind=kind,
            allocations=[dict(installment_id=id, amount=amount) for id, amount in rows],
        ),
    )


def balance(client, account):
    return next(
        a["balance"]
        for a in client.get("/api/balances").json()["accounts"]
        if a["account_id"] == account
    )


def test_rounding_leap_year_and_anchor():
    assert schedule(100_000, 3, dt.date(2028, 1, 31)) == [
        dict(number=1, due_date="2028-01-31", principal=33333),
        dict(number=2, due_date="2028-02-29", principal=33333),
        dict(number=3, due_date="2028-03-31", principal=33334),
    ]
    assert schedule(10, 3, dt.date(2027, 1, 31))[1]["due_date"] == "2027-02-28"


def test_purchase_two_payments_no_double_expense_and_retry(client):
    a = setup(client)
    created, body = purchase(client, a)
    assert client.post("/api/installments", json=body).json() == created
    p = plans(client)[0]
    assert len(p["installments"]) == 6
    assert balance(client, a["card"]) == -1_200_000
    txn = transaction(client, a["card"], a["cash"], 400_000)
    rows = [(r["id"], 200_000) for r in p["installments"][:2]]
    command = envelope(
        client,
        transaction_id=txn,
        kind="payment",
        allocations=[dict(installment_id=id, amount=amount) for id, amount in rows],
    )
    response = client.put("/api/installments/allocations", json=command)
    assert response.status_code == 200, response.text
    assert (
        client.put("/api/installments/allocations", json=command).json()
        == response.json()
    )
    assert plans(client)[0]["remaining_principal"] == 800_000
    assert balance(client, a["cash"]) == -400_000
    assert balance(client, a["expense"]) == 1_200_000
    assert len(client.get("/api/transactions").json()) == 2
    # Linked purchase/payment survive attempted edits/deletes, including raw unpost.
    for tid in (created["purchase_id"], txn):
        result = client.delete(f"/api/transactions/{tid}")
        assert result.status_code == 409, result.text
        assert result.json()["detail"]["code"] == "installment_transaction_linked"
    result = client.request(
        "DELETE", f"/api/installments/{created['id']}", json=envelope(client)
    )
    assert result.status_code == 409


def test_partial_allocation_projection_and_refund(client):
    a = setup(client)
    future = TODAY + dt.timedelta(days=1)
    created, _ = purchase(client, a, first_due_date=future.isoformat())
    r = plans(client)[0]["installments"][0]
    txn = transaction(client, a["card"], a["cash"], 50_000)
    assert allocate(client, txn, [(r["id"], 50_000)]).status_code == 200
    # Configure the same cash capability the existing scenario projections use.
    account = next(
        x for x in client.get("/api/accounts").json() if x["id"] == a["cash"]
    )
    response = client.put(
        f"/api/accounts/{a['cash']}/settings",
        json=dict(
            name=account["name"],
            parent_id=None,
            is_overdraft=False,
            version=account["version"],
            include_in_cash=True,
        ),
    )
    assert response.status_code == 200, response.text
    projection = client.get("/api/projection?scenario_id=1&months=12").json()
    assert projection["cash"]["baseline"]["points"][1]["balance"] == -200_000
    assert projection["cash"]["baseline"]["points"][-1]["balance"] == -1_200_000
    assert projection["cash"]["scenario"] == projection["cash"]["baseline"]
    assert all(
        p["balance"] == -1_200_000
        for p in projection["net_worth"]["baseline"]["points"]
    )
    assert all(
        m["baseline"]["expense"] == 0 for m in projection["monthly_income_expense"]
    )
    refund = transaction(client, a["card"], a["expense"], 150_000)
    assert allocate(client, refund, [(r["id"], 150_000)], "refund").status_code == 200
    assert plans(client)[0]["installments"][0]["remaining"] == 0
    assert balance(client, a["expense"]) == 1_050_000
    assert balance(client, a["cash"]) == -50_000
    assert (
        client.get("/api/projection?scenario_id=1&months=12").json()["cash"][
            "baseline"
        ]["points"][-1]["balance"]
        == -1_050_000
    )


def test_shared_payment_across_purchases_limits_and_rollback(client):
    a = setup(client)
    purchase(client, a)
    purchase(client, a, description="냉장고")
    ids = [p["installments"][0]["id"] for p in plans(client)]
    txn = transaction(client, a["card"], a["cash"], 300_000)
    assert (
        allocate(client, txn, [(ids[0], 200_000), (ids[1], 100_000)]).status_code == 200
    )
    failed = allocate(client, txn, [(ids[0], 200_000), (ids[1], 200_000)])
    assert failed.status_code == 400
    assert sum(p["remaining_principal"] for p in plans(client)) == 2_100_000
    # A second transaction cannot overpay a previously paid row.
    second = transaction(client, a["card"], a["cash"], 200_000)
    assert allocate(client, second, [(ids[0], 1)]).status_code == 400
    assert allocate(client, txn, []).status_code == 200
    assert sum(p["remaining_principal"] for p in plans(client)) == 2_400_000
    assert client.delete(f"/api/transactions/{txn}").status_code == 200


def test_conflict_retry_and_create_atomicity(client):
    a = setup(client)
    created, body = purchase(client, a)
    assert (
        client.post(
            "/api/installments", json={**body, "description": "different"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/installments", json={**body, "request_id": str(uuid.uuid4())}
        ).status_code
        == 409
    )
    with patch(
        "moneymap.adapters.sqlite.installments.schedule",
        side_effect=RuntimeError("fail after purchase"),
    ):
        with pytest.raises(RuntimeError):
            purchase(client, a)
    assert len(plans(client)) == 1
    assert len(client.get("/api/transactions").json()) == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"months": 1},
        {"months": 61},
        {"months": True},
        {"principal": 1},
        {"principal": 2.5},
        {"first_due_date": "1900-01-01"},
        {"description": " "},
        {"date": "2999-01-01", "first_due_date": "2999-02-01"},
    ],
)
def test_invalid_purchase(client, changes):
    a = setup(client)
    _, body = purchase(client, a)
    body.update(changes, request_id=str(uuid.uuid4()), expected_revision=2)
    assert client.post("/api/installments", json=body).status_code == (
        400 if changes.get("date") == "2999-01-01" else 422
    )
    assert len(plans(client)) == 1


def test_account_validation_reschedule_and_unlink(client):
    a = setup(client)
    created, body = purchase(client, a)
    invalid = envelope(
        client,
        **{
            k: v
            for k, v in body.items()
            if k not in {"expected_revision", "request_id"}
        },
    )
    invalid["card_account_id"] = a["cash"]
    assert client.post("/api/installments", json=invalid).status_code == 400
    assert client.post(f"/api/accounts/{a['card']}/archive").status_code == 409
    row = plans(client)[0]["installments"][0]
    assert (
        client.put(
            f"/api/installments/rows/{row['id']}",
            json=envelope(client, due_date="1900-01-01"),
        ).status_code
        == 400
    )
    due = (TODAY + dt.timedelta(days=8)).isoformat()
    assert (
        client.put(
            f"/api/installments/rows/{row['id']}", json=envelope(client, due_date=due)
        ).status_code
        == 200
    )
    txn = transaction(client, a["card"], a["cash"], 1)
    assert allocate(client, txn, [(row["id"], 1)]).status_code == 200
    assert (
        client.put(
            f"/api/installments/rows/{row['id']}", json=envelope(client, due_date=due)
        ).status_code
        == 409
    )
    assert allocate(client, txn, []).status_code == 200
    assert (
        client.request(
            "DELETE", f"/api/installments/{created['id']}", json=envelope(client)
        ).status_code
        == 200
    )
    assert client.get(f"/api/transactions/{created['purchase_id']}").status_code == 200
    assert (
        client.delete(f"/api/transactions/{created['purchase_id']}").status_code == 200
    )


def test_due_unconfirmed_warns_without_auto_posting(client):
    a = setup(client)
    purchase(client, a)
    assert plans(client)[0]["installments"][0]["status"] == "needs_confirmation"
    assert client.post("/api/materialize").json()["created"] == 0
    assert len(client.get("/api/transactions").json()) == 1
    result = client.get("/api/projection?scenario_id=1&months=12").json()
    assert any("미확인" in x for x in result["warnings"])
    assert client.get("/api/dashboard-projection").json()["warnings"]


def test_bill_overlap_requires_explicit_choice_and_detects_changes(client):
    a = setup(client)
    tomorrow = TODAY + dt.timedelta(days=1)
    created, _ = purchase(client, a, first_due_date=tomorrow.isoformat())
    rule = client.post(
        "/api/rules",
        json=dict(
            description="카드 전체",
            from_account_id=a["cash"],
            to_account_id=a["card"],
            amount=500_000,
            schedule=f"monthly:{tomorrow.day}",
            start_date=tomorrow.isoformat(),
        ),
    ).json()
    p = plans(client)[0]
    assert p["needs_projection_decision"]
    assert client.get("/api/projection?scenario_id=1&months=12").json()["warnings"]
    assert (
        client.put(
            f"/api/installments/{created['id']}",
            json=envelope(client, projection_mode="included", rule_signature="stale"),
        ).status_code
        == 409
    )
    assert (
        client.put(
            f"/api/installments/{created['id']}",
            json=envelope(
                client,
                projection_mode="included",
                rule_signature=p["current_rule_signature"],
            ),
        ).status_code
        == 200
    )
    assert not plans(client)[0]["needs_projection_decision"]
    assert not client.get("/api/projection?scenario_id=1&months=12").json()["warnings"]
    assert client.delete(f"/api/rules/{rule['id']}").status_code == 200
    assert plans(client)[0]["needs_projection_decision"]


def test_candidates_search_and_invalid_allocation(client):
    a = setup(client)
    created, _ = purchase(client, a)
    row = plans(client)[0]["installments"][0]
    assert (
        client.get("/api/installments/transactions?q=노트북").json()[0]["id"]
        == created["purchase_id"]
    )
    assert client.get("/api/installments/transactions?q=no-match").json() == []
    assert allocate(client, created["purchase_id"], [(row["id"], 1)]).status_code == 400
    wrong = transaction(client, a["expense"], a["cash"], 100)
    assert allocate(client, wrong, [(row["id"], 1)]).status_code == 400
    assert allocate(client, wrong, [(999999, 1)]).status_code == 404
    assert allocate(client, 999999, []).status_code == 404
    assert allocate(client, wrong, [(row["id"], 1), (row["id"], 1)]).status_code == 422


def test_live_archived_and_historical_fork_settlement_boundary(client):
    a = setup(client)
    old = TODAY - dt.timedelta(days=5)
    tomorrow = TODAY + dt.timedelta(days=1)
    purchase(client, a, date=old.isoformat(), first_due_date=tomorrow.isoformat())
    row = plans(client)[0]["installments"][0]
    txn = transaction(client, a["card"], a["cash"], 200_000)
    assert allocate(client, txn, [(row["id"], 200_000)]).status_code == 200
    account = next(
        x for x in client.get("/api/accounts").json() if x["id"] == a["cash"]
    )
    assert (
        client.put(
            f"/api/accounts/{a['cash']}/settings",
            json=dict(
                name=account["name"],
                parent_id=None,
                is_overdraft=False,
                include_in_cash=True,
                version=account["version"],
            ),
        ).status_code
        == 200
    )
    # Payment after historical fork must not disappear from the forecast;
    # it was not yet in that fork's actual opening balance.
    scenario = client.post(
        "/api/scenarios",
        json={"name": "할부 비교", "description": "", "fork_date": old.isoformat()},
    ).json()["scenario"]
    for state in ("active", "archived"):
        result = client.get(
            f"/api/projection?scenario_id={scenario['id']}&months=12"
        ).json()
        assert result["cash"]["baseline"]["points"][-1]["balance"] == -1_200_000
        assert result["cash"]["baseline"] == result["cash"]["scenario"]
        if state == "active":
            response = client.post(
                f"/api/scenarios/{scenario['id']}/archive",
                json={"version": scenario["version"]},
            )
            assert response.status_code == 200, response.text


def test_linked_transaction_edit_and_raw_sql_guard(client):
    import sqlite3
    from moneymap.adapters.sqlite import connect

    a = setup(client)
    created, _ = purchase(client, a)
    tid = created["purchase_id"]
    detail = client.get(f"/api/transactions/{tid}").json()
    command = {
        "request_id": str(uuid.uuid4()),
        "expected_version": detail["version"],
        "date": detail["date"],
        "description": "변경",
        "memo": "",
        "tags": [],
        "postings": [
            {
                "posting_id": p["posting_id"],
                "account_id": p["account_id"],
                "amount": p["amount"],
            }
            for p in detail["postings"]
        ],
    }
    # API payload conventions are covered by the transaction editing suite;
    # raw unposting is the shared storage guard used by edit and delete.
    conn = connect(client.app.state.db_path)
    try:
        with pytest.raises(
            sqlite3.IntegrityError, match="installment_transaction_linked"
        ):
            conn.execute("UPDATE transactions SET posted=0 WHERE id=?", (tid,))
        conn.rollback()
    finally:
        conn.close()
    result = client.put(f"/api/transactions/{tid}", json=command)
    assert result.status_code == 409, result.text


def test_v6_migration_preserves_ledger_and_is_idempotent(tmp_path):
    from moneymap.adapters.sqlite import connect, init_db
    from moneymap.adapters.sqlite import database

    conn = connect(str(tmp_path / "migration.db"))
    current = database.MIGRATIONS
    with patch.object(database, "MIGRATIONS", current[:6]):
        init_db(conn)
    from moneymap.domain import Money, Posting, Transaction
    from moneymap.adapters.sqlite.transactions import _insert_txn

    expense = conn.execute(
        "INSERT INTO accounts(name,type,position) VALUES('이관 비용','expense',100)"
    ).lastrowid
    cash = conn.execute(
        "INSERT INTO accounts(name,type,position) VALUES('이관 통장','asset',101)"
    ).lastrowid
    rule = conn.execute(
        "INSERT INTO recurring_rules(scenario_id,description,from_account_id,to_account_id,amount,schedule,start_date,last_materialized) VALUES(1,'기존 규칙',?,?,12345,'monthly:1','2024-01-01','2024-01-01')",
        (cash, expense),
    ).lastrowid
    _insert_txn(
        conn,
        Transaction(
            scenario_id=1,
            date=dt.date(2024, 1, 1),
            description="기존 거래",
            memo="원문 보존",
            tags=["이관", "생활"],
            source_rule_id=rule,
            postings=[
                Posting(account_id=expense, amount=Money(amount=12345)),
                Posting(account_id=cash, amount=Money(amount=-12345)),
            ],
        ),
    )
    conn.commit()
    tables = (
        "accounts",
        "transactions",
        "postings",
        "recurring_rules",
        "tags",
        "transaction_tags",
    )
    before = {
        table: [tuple(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
        for table in tables
    }
    init_db(conn)
    assert {
        table: [tuple(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
        for table in tables
    } == before
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(current)
    init_db(conn)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert list((tmp_path / "backups").glob("*"))
    conn.close()


def test_included_bill_capacity_is_shared_and_changes_warn(client):
    a = setup(client)
    tomorrow = TODAY + dt.timedelta(days=1)
    first, _ = purchase(client, a, first_due_date=tomorrow.isoformat())
    second, _ = purchase(client, a, first_due_date=tomorrow.isoformat())
    client.post(
        "/api/rules",
        json=dict(
            description="카드 전체",
            from_account_id=a["cash"],
            to_account_id=a["card"],
            amount=300_000,
            schedule=f"monthly:{tomorrow.day}",
            start_date=tomorrow.isoformat(),
        ),
    ).json()
    by_id = {p["id"]: p for p in plans(client)}
    one = client.put(
        f"/api/installments/{first['id']}",
        json=envelope(
            client,
            projection_mode="included",
            rule_signature=by_id[first["id"]]["current_rule_signature"],
        ),
    )
    assert one.status_code == 200, one.text
    two = client.put(
        f"/api/installments/{second['id']}",
        json=envelope(
            client,
            projection_mode="included",
            rule_signature=by_id[second["id"]]["current_rule_signature"],
        ),
    )
    assert two.status_code == 400, two.text
    # Merely choosing a same-card rule on a different day is not coverage.
    other = client.put(
        f"/api/installments/rows/{by_id[first['id']]['installments'][0]['id']}",
        json=envelope(client, due_date=(tomorrow + dt.timedelta(days=1)).isoformat()),
    )
    assert other.status_code == 200
    p = next(p for p in plans(client) if p["id"] == first["id"])
    assert (
        client.put(
            f"/api/installments/{first['id']}",
            json=envelope(
                client,
                projection_mode="included",
                rule_signature=p["current_rule_signature"],
            ),
        ).status_code
        == 400
    )


def test_exclude_one_off_only_when_explicit(client):
    from moneymap.adapters.sqlite import connect
    from moneymap.adapters.sqlite.projection import ProjectionInputReader

    a = setup(client)
    first, _ = purchase(client, a, exclude_from_spend=True)
    second, _ = purchase(client, a)
    conn = connect(client.app.state.db_path)
    try:
        _, txns = ProjectionInputReader(conn).legacy_actual_inputs(TODAY)
        assert first["purchase_id"] not in {t.id for t in txns}
        assert second["purchase_id"] in {t.id for t in txns}
    finally:
        conn.close()


@pytest.mark.parametrize("same_request", [True, False])
def test_concurrent_creates_replay_or_conflict_without_duplicate_purchase(
    client, same_request
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    a = setup(client)
    body = envelope(
        client,
        description="동시 저장",
        date=TODAY.isoformat(),
        debit_account_id=a["expense"],
        card_account_id=a["card"],
        cash_account_id=a["cash"],
        principal=1200,
        months=6,
        first_due_date=TODAY.isoformat(),
    )
    other = body if same_request else {**body, "request_id": str(uuid.uuid4())}
    gate = Barrier(2)

    def submit(command):
        gate.wait()
        return client.post("/api/installments", json=command)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(submit, [body, other]))
    assert sorted(r.status_code for r in responses) == (
        [201, 201] if same_request else [201, 409]
    )
    if same_request:
        assert responses[0].json() == responses[1].json()
    assert len(plans(client)) == 1
    assert len(client.get("/api/transactions").json()) == 1


@pytest.mark.parametrize("account_key", ["card", "cash"])
@pytest.mark.parametrize(
    "change",
    ["child_insert", "child_update", "archived", "is_placeholder", "type", "currency"],
)
def test_installment_account_lifecycle_guards_preserve_accounts(
    client, account_key, change
):
    import sqlite3
    from moneymap.adapters.sqlite import connect

    a = setup(client)
    purchase(client, a)
    child = make_account(
        client, "독립 계정", "asset" if account_key == "cash" else "liability"
    )
    conn = connect(client.app.state.db_path)
    try:
        before = [tuple(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")]
        with pytest.raises(sqlite3.IntegrityError, match="installment_account_linked"):
            if change == "child_insert":
                conn.execute(
                    "INSERT INTO accounts(name,type,parent_id,position) VALUES('자식','asset',?,100)",
                    (a[account_key],),
                )
            elif change == "child_update":
                conn.execute(
                    "UPDATE accounts SET parent_id=? WHERE id=?",
                    (a[account_key], child),
                )
            else:
                value = {
                    "archived": 1,
                    "is_placeholder": 1,
                    "type": "expense",
                    "currency": "USD",
                }[change]
                conn.execute(
                    f"UPDATE accounts SET {change}=? WHERE id=?",
                    (value, a[account_key]),
                )
        conn.rollback()
        assert [
            tuple(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")
        ] == before
    finally:
        conn.close()
    assert plans(client)[0]["remaining_principal"] == 1_200_000


@pytest.mark.parametrize("invalid", ["future", "prepurchase", "foreign_currency"])
def test_allocation_rejects_ineligible_transaction_without_changes(client, invalid):
    from moneymap.adapters.sqlite import connect
    from moneymap.adapters.sqlite.transactions import _insert_txn
    from moneymap.domain import Money, Posting, Transaction

    a = setup(client)
    purchase(client, a)
    row = plans(client)[0]["installments"][0]
    date = TODAY + dt.timedelta(
        days={"future": 1, "prepurchase": -1, "foreign_currency": 0}[invalid]
    )
    currency = "USD" if invalid == "foreign_currency" else "KRW"
    # Seed historical/foreign-currency ledger records through the storage boundary
    # so the allocation guard itself is exercised.
    conn = connect(client.app.state.db_path)
    try:
        tid = _insert_txn(
            conn,
            Transaction(
                scenario_id=1,
                date=date,
                description="배분 불가 거래",
                postings=[
                    Posting(
                        account_id=a["card"],
                        amount=Money(amount=100, currency=currency),
                    ),
                    Posting(
                        account_id=a["cash"],
                        amount=Money(amount=-100, currency=currency),
                    ),
                ],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    before = client.get("/api/installments").json()
    result = allocate(client, tid, [(row["id"], 100)])
    assert result.status_code == 400, result.text
    assert client.get("/api/installments").json() == before


@pytest.mark.parametrize("action", ["update", "reschedule", "delete"])
def test_missing_installment_targets_return_not_found_without_revision_change(
    client, action
):
    before = client.get("/api/installments").json()
    if action == "update":
        result = client.put(
            "/api/installments/999999",
            json=envelope(client, projection_mode="separate", rule_signature=""),
        )
    elif action == "reschedule":
        result = client.put(
            "/api/installments/rows/999999",
            json=envelope(client, due_date=TODAY.isoformat()),
        )
    else:
        result = client.request(
            "DELETE", "/api/installments/999999", json=envelope(client)
        )
    assert result.status_code == 404, result.text
    assert result.json()["detail"]["code"] == "installment_not_found"
    assert client.get("/api/installments").json() == before
