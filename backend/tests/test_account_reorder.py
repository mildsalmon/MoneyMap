import pytest
from fastapi.testclient import TestClient

from moneymap.api import create_app
from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite.accounts import SqliteAccountRepository
from moneymap.domain.account import Account, AccountType
from moneymap.domain.account_order import AccountReorderCommand
from moneymap.domain.errors import DomainInvariantError


@pytest.fixture
def client():
    with TestClient(create_app(":memory:")) as client:
        yield client


def create(client, name, **kwargs):
    response = client.post("/api/accounts", json={"name": name, "type": "expense", **kwargs})
    assert response.status_code == 201, response.text
    return response.json()


def payload(accounts, **kwargs):
    return {"type": "expense", "parent_id": None,
            "ordered_accounts": [{"id": a["id"], "version": a["version"]} for a in accounts], **kwargs}


def test_reorder_preserves_archived_slot_noop_and_stale(client):
    a, archived, b = [create(client, name) for name in ["A", "archived", "B"]]
    client.post(f'/api/accounts/{archived["id"]}/archive')
    snapshot = client.get("/api/accounts").json()
    response = client.put("/api/accounts/reorder", json=payload([b, a]))
    assert response.status_code == 200, response.text
    saved = response.json()["accounts"]
    assert [x["position"] for x in saved] == [a["position"], b["position"]]
    assert [x["version"] for x in saved] == [2, 2]
    assert response.json()["effects"]["changed_account_ids"] == [b["id"], a["id"]]
    untouched = [x for x in snapshot if x["id"] not in [a["id"], b["id"]]]
    assert [x for x in client.get("/api/accounts").json() if x["id"] not in [a["id"], b["id"]]] == untouched
    noop = client.put("/api/accounts/reorder", json=payload(saved))
    assert noop.json() == {"accounts": saved, "effects": {"changed_account_ids": []}}
    stale = client.put("/api/accounts/reorder", json=payload([b, a]))
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "account_reorder_stale"
    restored = client.put("/api/accounts/reorder", json=payload(list(reversed(saved))))
    assert restored.status_code == 200
    assert client.post(f'/api/accounts/{archived["id"]}/restore').json()["position"] == archived["position"]


def test_group_move_leaves_descendants_and_ledger_unchanged(client):
    a = create(client, "A", is_placeholder=True)
    b = create(client, "B", is_placeholder=True)
    child = create(client, "child", parent_id=a["id"])
    bank = create(client, "bank", type="asset")
    txn = client.post("/api/transactions", json={"date": "2026-01-01", "description": "example", "postings": [
        {"account_id": child["id"], "amount": 123}, {"account_id": bank["id"], "amount": -123}]})
    assert txn.status_code == 201, txn.text
    transactions = client.get("/api/transactions").json()
    balances = client.get("/api/balances").json()
    response = client.put("/api/accounts/reorder", json=payload([b, a]))
    assert response.status_code == 200
    assert next(x for x in client.get("/api/accounts").json() if x["id"] == child["id"]) == child
    assert client.get("/api/transactions").json() == transactions
    after = client.get("/api/balances").json()
    assert sorted(after.pop("accounts"), key=lambda x: x["account_id"]) == sorted(balances.pop("accounts"), key=lambda x: x["account_id"])
    assert after == balances


@pytest.mark.parametrize("case,status,code", [
    ("duplicate",400,"account_reorder_duplicate"), ("missing",404,"account_reorder_account_not_found"),
    ("parent",404,"account_reorder_parent_not_found"), ("nongroup",409,"account_reorder_parent_forbidden"),
    ("parent_type",409,"account_reorder_parent_type_mismatch"),
    ("scope",409,"account_reorder_scope_mismatch"), ("set",409,"account_reorder_set_mismatch"),
    ("archived",409,"account_reorder_forbidden"), ("system",409,"account_reorder_forbidden"),
])
def test_invalid_snapshot_is_atomic(client, case, status, code):
    a, b, c = [create(client, n) for n in ["a", "b", "c"]]
    body = payload([c, b, a])
    if case == "duplicate": body["ordered_accounts"][0] = body["ordered_accounts"][1]
    if case == "missing": body["ordered_accounts"][0]["id"] = 99999
    if case == "parent": body["parent_id"] = 99999
    if case == "nongroup": body["parent_id"] = a["id"]
    if case == "parent_type": body["parent_id"] = create(client, "asset group", type="asset", is_placeholder=True)["id"]
    if case == "scope": body["type"] = "asset"
    if case == "set": body["ordered_accounts"].pop()
    if case == "archived": client.post(f'/api/accounts/{a["id"]}/archive')
    if case == "system": body["ordered_accounts"][0]["id"] = next(x["id"] for x in client.get("/api/accounts").json() if x["is_system"])
    snapshot = client.get("/api/accounts").json()
    response = client.put("/api/accounts/reorder", json=body)
    assert response.status_code == status, response.text
    assert response.json()["detail"]["code"] == code
    assert client.get("/api/accounts").json() == snapshot


@pytest.mark.parametrize("body", [{}, {"type":"expense", "parent_id":None, "ordered_accounts":[]},
                                  {"type":"bad", "parent_id":None, "ordered_accounts":[{"id":1,"version":1}]*2}])
def test_shape_validation(client, body):
    assert client.put("/api/accounts/reorder", json=body).status_code == 422


def test_child_reorder_unchanged_middle_version(client):
    group = create(client, "group", is_placeholder=True)
    a, b, c = [create(client, n, parent_id=group["id"]) for n in ["a", "b", "c"]]
    result = client.put("/api/accounts/reorder", json=payload([c, b, a], parent_id=group["id"]))
    assert result.status_code == 200, result.text
    assert [x["version"] for x in result.json()["accounts"]] == [2, 1, 2]


@pytest.mark.parametrize("overflow", [False, True])
def test_sqlite_position_boundary_and_failure_rollback(overflow):
    conn = connect(":memory:"); init_db(conn)
    try:
        repo = SqliteAccountRepository(conn)
        a, b = [repo.create(Account(name=n, type=AccountType.EXPENSE)) for n in ["a", "b"]]
        if overflow:
            conn.execute("UPDATE accounts SET position=? WHERE id=?", (9_223_372_036_854_775_807, b.id)); conn.commit()
        else:
            conn.execute("CREATE TRIGGER fail_reorder BEFORE UPDATE OF position ON accounts WHEN NEW.position < OLD.position BEGIN SELECT RAISE(ABORT, 'account_position_invalid'); END")
        before = repo.find_all()
        with pytest.raises(DomainInvariantError) as caught:
            repo.reorder(AccountReorderCommand(**payload([b.model_dump(), a.model_dump()])))
        assert caught.value.code == ("account_position_temp_range_exhausted" if overflow else "account_position_invariant")
        assert repo.find_all() == before
    finally:
        conn.close()
