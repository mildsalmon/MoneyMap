"""Receipt identities, signed totals, metadata-only edits and v12 adoption."""
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from fixtures.account_history_ledger import seed_v11
from moneymap.adapters.sqlite import connect, database, init_db
from moneymap.api import create_app

DAY = "2020-05-01"
CATEGORIES = "/api/living-categories"
TXNS = "/api/transactions"


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "test.db"))) as app:
        yield app


def account(client, kind, name):
    r = client.post("/api/accounts", json={"name": name, "type": kind})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def category(client, name):
    r = client.post(CATEGORIES, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def report(client):
    r = client.get("/api/statistics", params={"start": DAY, "end": DAY})
    assert r.status_code == 200, r.text
    return r.json()


def edit(detail):
    return {**{k: detail[k] for k in ("description", "memo", "date", "tags")},
            "expected_version": detail["version"], "request_id": str(uuid4()),
            "postings": [{k: v for k, v in p.items() if k != "currency"} for p in detail["postings"]]}


def test_classify_split_receipt_and_rename_without_reposting(client):
    bank = account(client, "asset", "통장")
    meal = account(client, "expense", "식비")
    fare = account(client, "expense", "교통비")
    delivery, transit, dining = [category(client, name) for name in ("배달", "택시", "외식")]
    r = client.post(TXNS, json={"date": DAY, "tags": ["출장"], "postings": [
        {"account_id": bank, "amount": -12000},
        {"account_id": meal, "amount": 8000, "category_id": delivery},
        {"account_id": fare, "amount": 4000, "category_id": transit}]})
    assert r.status_code == 201, r.text
    url = f"{TXNS}/{r.json()['id']}"
    original = client.get(url).json()
    before = report(client)
    assert before["summary"]["expense"] == 12000
    assert before["summary"]["assets"] == -12000
    assert {r["name"]: r["expense"] for r in before["categories"]} == {"배달": 8000, "택시": 4000, "미분류": 0}

    # Abort if even a transient unpost occurs (including a client reordering the legs).
    with connect(client.app.state.db_path) as db:
        db.execute("""CREATE TRIGGER test_no_unpost BEFORE UPDATE OF posted ON transactions
                      BEGIN SELECT RAISE(ABORT,'unexpected ledger write'); END""")
    body = edit(original)
    body["postings"][1]["category_id"] = dining
    body["postings"].reverse()
    saved = client.put(url, json=body).json()["transaction"]
    assert saved["version"] != original["version"]
    assert saved["id"] == original["id"] and saved["tags"] == ["출장"]
    assert [{k: p[k] for k in ("posting_id", "account_id", "amount")} for p in saved["postings"]] == [
        {k: p[k] for k in ("posting_id", "account_id", "amount")} for p in original["postings"]]
    assert client.put(url, json=body).json()["result_version"] == saved["version"]
    assert client.put(url, json=edit(original)).status_code == 409
    assert client.put(f"{CATEGORIES}/{dining}", json={"name": "식당"}).json() == {"id": dining, "name": "식당"}
    after = report(client)
    assert after["categories"] == [{"category_id": dining, "name": "식당", "expense": 8000, "income": 0},
                                    {"category_id": transit, "name": "택시", "expense": 4000, "income": 0},
                                    {"category_id": None, "name": "미분류", "expense": 0, "income": 0}]
    assert after["balances"] == before["balances"] and after["summary"] == before["summary"]
    assert client.get(url).json() == saved

    old_client = edit(saved)
    for p in old_client["postings"]:
        p.pop("category_id", None)
    assert client.put(url, json=old_client).json()["transaction"]["postings"] == saved["postings"]
    clear = edit(client.get(url).json())
    clear["postings"][1]["category_id"] = None
    assert client.put(url, json=clear).status_code == 200
    assert report(client)["categories"][-1]["expense"] == 8000


def test_invalid_assignments_roll_back_and_income_and_reversals_keep_sign(client):
    bank = account(client, "asset", "bank")
    income = account(client, "income", "income")
    cat = category(client, "Investment")
    payload = {"date": DAY, "postings": [
        {"account_id": income, "category_id": cat, "amount": -41}, {"account_id": bank, "amount": 41}]}
    for index, bad in ((1, cat), (0, 9999)):
        rows = [p.copy() for p in payload["postings"]]
        rows[index]["category_id"] = bad
        assert client.post(TXNS, json={**payload, "postings": rows}).status_code == 400
    assert client.get(TXNS).json() == []
    r = client.post(TXNS, json=payload)
    assert r.status_code == 201
    url = f"{TXNS}/{r.json()['id']}"
    detail = client.get(url).json()
    invalid = edit(detail)
    invalid["postings"][1]["category_id"] = cat
    assert client.put(url, json=invalid).status_code == 400
    assert client.get(url).json() == detail
    payload["postings"][0]["amount"], payload["postings"][1]["amount"] = 3, -3
    assert client.post(TXNS, json=payload).status_code == 201
    assert report(client)["categories"][0]["income"] == 38
    assert client.delete(url).status_code == 200
    assert report(client)["categories"][0]["income"] == -3


def test_catalog_identity_and_reserved_name(client):
    first = category(client, "  Cafe\u0301  ")
    second = category(client, "Coffee")
    assert client.post(CATEGORIES, json={"name": "CAFÉ"}).status_code == 409
    assert client.put(f"{CATEGORIES}/{second}", json={"name": "Café"}).status_code == 409
    for name in (" ", "미분류", "x" * 51):
        assert client.post(CATEGORIES, json={"name": name}).status_code == 422
    assert client.put(f"{CATEGORIES}/999", json={"name": "other"}).status_code == 404
    assert client.get(CATEGORIES).json() == [{"id": first, "name": "Café"}, {"id": second, "name": "Coffee"}]


def test_v12_upgrade_preserves_historical_rows_tags_and_versions(tmp_path):
    path = tmp_path / "old.db"
    seed_v11(path)
    conn = connect(str(path))
    with patch.object(database, "MIGRATIONS", database.MIGRATIONS[:12]):
        init_db(conn)
    with conn:
        conn.execute("INSERT INTO tags(id,name,name_key) VALUES(3,'출장','출장')")
        conn.execute("INSERT INTO transaction_tags(txn_id,tag_id) VALUES(31,3)")

    def historical_rows():
        return {table: list(map(tuple, conn.execute(f"SELECT * FROM {table} ORDER BY rowid")))
                for table in ("accounts", "postings", "transactions", "tags", "transaction_tags",
                              "account_balance_history", "account_state_events")}

    before = historical_rows()
    init_db(conn)
    init_db(conn)
    assert historical_rows() == before
    assert not conn.execute("PRAGMA foreign_key_check").fetchall()
    conn.close()
    with TestClient(create_app(str(path))) as app:
        assert app.get(CATEGORIES).json() == []
        assert report(app)["categories"] == [{"category_id": None, "name": "미분류", "expense": 500, "income": 0}]


def test_split_edit_adds_category_to_new_leg_and_old_client_clears_ineligible_leg(client):
    bank = account(client, "asset", "bank")
    cash = account(client, "asset", "cash")
    meal = account(client, "expense", "meal")
    cat = category(client, "배달")
    created = client.post(TXNS, json={"date": DAY, "postings": [
        {"account_id": bank, "amount": -100}, {"account_id": meal, "amount": 100, "category_id": cat}]})
    url = f"{TXNS}/{created.json()['id']}"
    body = edit(client.get(url).json())
    body["postings"][1].pop("category_id")
    body["postings"][1].update(account_id=cash, amount=60)
    body["postings"].append({"account_id": meal, "amount": 40, "category_id": cat})
    saved = client.put(url, json=body).json()["transaction"]
    cash_leg, expense_leg = saved["postings"][1:]
    assert cash_leg["posting_id"] == body["postings"][1]["posting_id"] and "category_id" not in cash_leg
    assert expense_leg["category_id"] == cat
    assert report(client)["categories"][0]["expense"] == 40
