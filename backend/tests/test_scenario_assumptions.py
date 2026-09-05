"""PR3 ownership, exact-once versioning and database-boundary rollback checks."""

import pytest
from moneymap.adapters.sqlite import connect
from moneymap.adapters.sqlite.transactions import ScenarioTransactionWriter
from test_scenario_lifecycle import create, account, rule_body, state
import test_scenario_lifecycle as lifecycle

client = lifecycle.client


@pytest.fixture
def setup(client):
    sid = create(client)["id"]
    body = {
        "date": "2026-02-01",
        "description": "계획",
        "scenario_version": 1,
        "postings": [
            {
                "account_id": account(client, "예정은행", "asset"),
                "amount": 100,
                "currency": "KRW",
            },
            {
                "account_id": account(client, "수입", "income"),
                "amount": -100,
                "currency": "KRW",
            },
        ],
    }
    return sid, f"/api/scenarios/{sid}/planned-transactions", body


def test_crud_exactly_once_and_full_replacement(client, setup):
    sid, path, body = setup
    created = client.post(path, json=body)
    assert created.status_code == 201, created.text
    txn = created.json()["transaction"]
    assert created.json()["scenario_version"] == 2
    assert client.post(path, json=body).status_code == 409
    assert len(client.get(path).json()) == 1
    changed = {
        **body,
        "scenario_version": 2,
        "description": "변경",
        "date": "2027-03-02",
        "postings": [
            {**body["postings"][0], "amount": 300},
            {**body["postings"][1], "amount": -100},
            {**body["postings"][1], "amount": -200},
        ],
    }
    result = client.put(f"{path}/{txn['id']}", json=changed)
    assert result.status_code == 200, result.text
    assert result.json()["transaction"]["id"] == txn["id"]
    assert result.json()["scenario_version"] == 3
    assert len(client.get(path).json()[0]["postings"]) == 3
    conn = connect(client.app.state.db_path)
    assert (
        conn.execute(
            "SELECT posted FROM transactions WHERE id=?", (txn["id"],)
        ).fetchone()[0]
        == 1
    )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM postings WHERE txn_id=?", (txn["id"],)
        ).fetchone()[0]
        == 3
    )
    for token, status in [(None, 428), ('W/"bad"', 400), (f'"scenario-{sid}-v2"', 412)]:
        before = state(conn)
        assert (
            client.delete(
                f"{path}/{txn['id']}", headers={"If-Match": token} if token else {}
            ).status_code
            == status
        )
        assert state(conn) == before
    result = client.delete(
        f"{path}/{txn['id']}", headers={"If-Match": f'"scenario-{sid}-v3"'}
    )
    assert result.status_code == 200 and result.json()["scenario_version"] == 4
    assert client.get(path).json() == []
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM postings WHERE txn_id=?", (txn["id"],)
        ).fetchone()[0]
        == 0
    )
    conn.close()


@pytest.mark.parametrize(
    "patch,status",
    [
        ({"date": "2026-01-31"}, 409),
        ({"scenario_id": 1}, 422),
        ({"source_rule_id": 1}, 422),
        ({"scenario_version": 9}, 409),
        ({"postings": []}, 422),
    ],
)
def test_input_rejection_does_not_write(client, setup, patch, status):
    sid, path, body = setup
    conn = connect(client.app.state.db_path)
    before = state(conn)
    assert client.post(path, json={**body, **patch}).status_code == status
    assert state(conn) == before
    conn.close()


@pytest.mark.parametrize(
    "field,value",
    [("amount", 0), ("amount", 99), ("currency", "USD"), ("account_id", 999999)],
)
def test_invalid_postings_preserve_database(client, setup, field, value):
    _, path, body = setup
    body["postings"][0][field] = value
    conn = connect(client.app.state.db_path)
    before = state(conn)
    assert client.post(path, json=body).status_code in (400, 404)
    assert state(conn) == before
    conn.close()


def test_duplicate_owned_only_new_identity_and_conflicts(client, setup):
    sid, path, body = setup
    owned = rule_body(client)
    rule = client.post(f"/api/scenarios/{sid}/rules", json=owned).json()["rule"]
    actual = client.post(
        "/api/rules", json={k: v for k, v in owned.items() if k != "scenario_version"}
    )
    assert actual.status_code == 201
    txn = client.post(path, json={**body, "scenario_version": 2}).json()["transaction"]
    conn = connect(client.app.state.db_path)
    with conn:
        tid = conn.execute(
            "INSERT INTO transactions(scenario_id,date,source_rule_id) VALUES(?,?,?)",
            (sid, "2026-02-28", rule["id"]),
        ).lastrowid
        conn.executemany(
            "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
            [(tid, p["account_id"], p["amount"]) for p in body["postings"]],
        )
        conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (tid,))
        conn.execute(
            "UPDATE recurring_rules SET last_materialized='2026-02-28' WHERE id=?",
            (rule["id"],),
        )
    assert [t["id"] for t in client.get(path).json()] == [txn["id"]]
    duplicate = {
        "name": "복사",
        "description": "새 설명",
        "fork_date": "2026-01-30",
        "version": 3,
    }
    before = state(conn)
    for patch, code in [
        ({"version": 1}, "scenario_version_conflict"),
        ({"fork_date": "2026-02-01"}, "scenario_duplicate_date_conflict"),
    ]:
        result = client.post(
            f"/api/scenarios/{sid}/duplicate", json={**duplicate, **patch}
        )
        assert result.status_code == 409
        assert result.json()["detail"]["code"] == code
        if code.endswith("date_conflict"):
            assert result.json()["detail"]["transactions"] == [txn]
        assert state(conn) == before
    copied = client.post(f"/api/scenarios/{sid}/duplicate", json=duplicate)
    assert copied.status_code == 201, copied.text
    data = copied.json()
    dest = data["scenario"]
    assert data["copied"] == {"rules": 1, "planned_transactions": 1}
    assert (
        dest["version"] == 1
        and dest["status"] == "active"
        and dest["rule_mode"] == "live_additive"
    )
    newrule = client.get(f"/api/scenarios/{dest['id']}/rules").json()[0]
    assert newrule["id"] != rule["id"] and newrule["last_materialized"] is None
    assert newrule["start_date"] == rule["start_date"]
    newtxn = client.get(f"/api/scenarios/{dest['id']}/planned-transactions").json()[0]
    assert newtxn["id"] != txn["id"] and newtxn["postings"] == txn["postings"]
    assert client.get(f"/api/scenarios/{sid}").json()["version"] == 3
    for target in [tid, newtxn["id"]]:
        assert (
            client.put(
                f"{path}/{target}", json={**body, "scenario_version": 3}
            ).status_code
            == 404
        )
        assert (
            client.delete(
                f"{path}/{target}", headers={"If-Match": f'"scenario-{sid}-v3"'}
            ).status_code
            == 404
        )
    conn.close()


@pytest.mark.parametrize(
    "action,trigger",
    [
        ("create", "BEFORE INSERT ON transactions"),
        ("create", "BEFORE INSERT ON postings"),
        ("create", "BEFORE UPDATE OF posted ON transactions WHEN NEW.posted=1"),
        ("update", "AFTER UPDATE OF posted ON transactions WHEN NEW.posted=0"),
        ("update", "AFTER DELETE ON postings"),
        ("update", "AFTER UPDATE OF description ON transactions"),
        ("update", "AFTER INSERT ON postings"),
        ("update", "BEFORE UPDATE OF posted ON transactions WHEN NEW.posted=1"),
        ("delete", "AFTER UPDATE OF posted ON transactions WHEN NEW.posted=0"),
        ("delete", "AFTER DELETE ON postings"),
        ("delete", "AFTER DELETE ON transactions"),
        ("duplicate", "AFTER INSERT ON scenarios"),
        ("duplicate", "AFTER INSERT ON recurring_rules"),
        ("duplicate", "AFTER INSERT ON transactions"),
        ("duplicate", "AFTER INSERT ON postings"),
        ("duplicate", "BEFORE UPDATE OF posted ON transactions WHEN NEW.posted=1"),
    ],
)
def test_every_write_boundary_rolls_back(client, setup, action, trigger):
    sid, path, body = setup
    txn = client.post(path, json=body).json()["transaction"]
    rb = rule_body(client)
    assert (
        client.post(
            f"/api/scenarios/{sid}/rules", json={**rb, "scenario_version": 2}
        ).status_code
        == 201
    )
    # Include actual and unrelated scenario data in the complete snapshot.
    other = create(client, "다른 계획")["id"]
    assert (
        client.post(
            f"/api/scenarios/{other}/planned-transactions", json=body
        ).status_code
        == 201
    )
    assert (
        client.post(
            "/api/transactions",
            json={k: v for k, v in body.items() if k != "scenario_version"}
            | {
                "postings": [
                    {"account_id": p["account_id"], "amount": p["amount"]}
                    for p in body["postings"]
                ]
            },
        ).status_code
        == 201
    )
    conn = connect(client.app.state.db_path)
    before = state(conn)
    conn.execute(
        f"CREATE TRIGGER injected {trigger} BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    if action == "create":
        result = client.post(path, json={**body, "scenario_version": 3})
    elif action == "update":
        result = client.put(
            f"{path}/{txn['id']}",
            json={**body, "scenario_version": 3, "description": "변경"},
        )
    elif action == "delete":
        result = client.delete(
            f"{path}/{txn['id']}", headers={"If-Match": f'"scenario-{sid}-v3"'}
        )
    else:
        result = client.post(
            f"/api/scenarios/{sid}/duplicate",
            json={"name": "copy", "fork_date": "2026-01-30", "version": 3},
        )
    assert result.status_code == 400, result.text
    assert state(conn) == before
    conn.execute("DROP TRIGGER injected")
    retry = client.request(
        result.request.method,
        str(result.request.url),
        content=result.request.content,
        headers=dict(result.request.headers),
    )
    assert retry.status_code == (201 if action in ("create", "duplicate") else 200), (
        retry.text
    )
    assert client.get(f"/api/scenarios/{sid}").json()["version"] == (
        3 if action == "duplicate" else 4
    )
    conn.close()


@pytest.mark.parametrize(
    "mode,code",
    [
        ("archived", "scenario_archived_read_only"),
        ("legacy_snapshot", "legacy_rule_resolution_required"),
    ],
)
def test_state_guards_precede_version(client, setup, mode, code):
    sid, path, body = setup
    tid = client.post(path, json=body).json()["transaction"]["id"]
    conn = connect(client.app.state.db_path)
    with conn:
        if mode == "archived":
            conn.execute(
                "UPDATE scenarios SET status='archived',archived_at=CURRENT_TIMESTAMP WHERE id=?",
                (sid,),
            )
        else:
            conn.execute(
                "UPDATE scenarios SET rule_mode='legacy_snapshot' WHERE id=?", (sid,)
            )
    for response in [
        client.post(path, json=body),
        client.put(f"{path}/{tid}", json=body),
        client.delete(f"{path}/{tid}"),
        client.post(
            f"/api/scenarios/{sid}/duplicate",
            json={"name": "x", "fork_date": "2026-01-30", "version": 1},
        ),
    ]:
        assert response.status_code == 409 and response.json()["detail"]["code"] == code
    assert client.get(path).status_code == 200
    conn.close()


def test_list_uses_one_join(client, setup):
    sid, path, body = setup
    for v in range(1, 11):
        assert (
            client.post(path, json={**body, "scenario_version": v}).status_code == 201
        )
    conn = connect(client.app.state.db_path)
    statements = []
    conn.set_trace_callback(statements.append)
    assert len(ScenarioTransactionWriter(conn).list_owned(sid)) == 10
    assert len(statements) == 1 and "JOIN postings" in statements[0]
    conn.close()


@pytest.mark.parametrize("action", ["create", "update"])
@pytest.mark.parametrize("foreign_account", [False, True])
def test_foreign_currency_cannot_be_folded_as_krw(
    client, setup, action, foreign_account
):
    sid, path, body = setup
    if action == "update":
        tid = client.post(path, json=body).json()["transaction"]["id"]
        body["scenario_version"] = 2
        path += f"/{tid}"
    conn = connect(client.app.state.db_path)
    if foreign_account:
        with conn:
            conn.execute(
                "UPDATE accounts SET currency='USD' WHERE id=?",
                (body["postings"][0]["account_id"],),
            )
    else:
        for p in body["postings"]:
            p["currency"] = "USD"
    before = state(conn)
    response = client.request("PUT" if action == "update" else "POST", path, json=body)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "scenario_currency_unsupported"
    assert state(conn) == before
    conn.close()


def test_planned_projection_exactly_once_update_delete(client, setup):
    sid, path, body = setup
    projection = f"/api/projection?scenario_id={sid}&months=3"

    def balance():
        data = client.get(projection).json()
        assert data["net_worth"]["baseline"]["points"][-1]["balance"] == 0
        return data["net_worth"]["scenario"]["points"][-1]["balance"]

    tid = client.post(path, json=body).json()["transaction"]["id"]
    assert balance() == 100
    assert client.post(path, json=body).status_code == 409
    assert balance() == 100
    body["scenario_version"] = 2
    for p in body["postings"]:
        p["amount"] *= 2
    assert client.put(f"{path}/{tid}", json=body).status_code == 200
    assert balance() == 200
    # Horizon exclusion never deletes the underlying assumption.
    assert (
        client.put(
            f"{path}/{tid}", json={**body, "scenario_version": 3, "date": "2028-01-01"}
        ).status_code
        == 200
    )
    assert balance() == 0 and len(client.get(path).json()) == 1
    assert (
        client.delete(
            f"{path}/{tid}", headers={"If-Match": f'"scenario-{sid}-v4"'}
        ).status_code
        == 200
    )
    assert balance() == 0


def test_actual_and_missing_guards_and_foreign_transaction(client, setup):
    sid, path, body = setup
    actual = client.post(
        "/api/transactions",
        json={
            "date": body["date"],
            "postings": [
                {"account_id": p["account_id"], "amount": p["amount"]}
                for p in body["postings"]
            ],
        },
    ).json()
    conn = connect(client.app.state.db_path)
    before = state(conn)
    for response in [
        client.get("/api/scenarios/1/planned-transactions"),
        client.post("/api/scenarios/1/planned-transactions", json=body),
        client.put(f"/api/scenarios/1/planned-transactions/{actual['id']}", json=body),
        client.delete(f"/api/scenarios/1/planned-transactions/{actual['id']}"),
        client.post(
            "/api/scenarios/1/duplicate",
            json={"name": "copy", "fork_date": "2026-01-31", "version": 1},
        ),
    ]:
        assert (
            response.status_code == 400
            and response.json()["detail"]["code"] == "actual_scenario_protected"
        )
    for method in ("PUT", "DELETE"):
        response = client.request(
            method,
            f"{path}/{actual['id']}",
            json=body if method == "PUT" else None,
            headers={"If-Match": f'"scenario-{sid}-v1"'},
        )
        assert response.status_code == 404
    assert (
        client.post(
            "/api/scenarios/999999/duplicate",
            json={"name": "copy", "fork_date": "2026-01-31", "version": 1},
        ).status_code
        == 404
    )
    assert state(conn) == before
    conn.close()


def test_simultaneous_planned_commands_have_one_winner(client, setup):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from moneymap.app_services.assumptions import mutate_planned
    from moneymap.adapters.sqlite.uow import SqliteUnitOfWork
    from moneymap.domain.errors import DomainConflictError
    from moneymap.routers.scenarios import PlannedIn

    sid, path, body = setup
    ready = Barrier(2)

    def writer(_):
        conn = connect(client.app.state.db_path)
        try:
            ready.wait(timeout=5)
            try:
                return mutate_planned(
                    sid, None, PlannedIn(**body), None, SqliteUnitOfWork(conn)
                )["scenario_version"]
            except DomainConflictError as e:
                return e.code
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert set(pool.map(writer, range(2))) == {2, "scenario_version_conflict"}
    assert len(client.get(path).json()) == 1
