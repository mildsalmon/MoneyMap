from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from moneymap.api import create_app
from moneymap.adapters.sqlite import connect
from moneymap.adapters.sqlite.uow import SqliteUnitOfWork
from moneymap.app_services import scenarios as service
from moneymap.domain.errors import DomainConflictError

DAY = "2026-01-31"


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "lifecycle.db"))) as client:
        yield client


def create(client, name="계획"):
    result = client.post(
        "/api/scenarios", json={"name": name, "description": "설명", "fork_date": DAY}
    )
    assert result.status_code == 201, result.text
    return result.json()["scenario"]


def account(client, name, kind):
    return client.post("/api/accounts", json={"name": name, "type": kind}).json()["id"]


def rule_body(client):
    return {
        "description": "급여",
        "from_account_id": account(client, "급여", "income"),
        "to_account_id": account(client, "은행", "asset"),
        "amount": 100,
        "schedule": "monthly:31",
        "start_date": DAY,
        "scenario_version": 1,
    }


def state(conn):
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


def test_creation_identity_validation_and_live_rules(client):
    body = rule_body(client)
    actual = client.post(
        "/api/rules", json={k: v for k, v in body.items() if k != "scenario_version"}
    ).json()
    scenario = create(client)
    sid = scenario["id"]
    assert scenario["status"] == "active" and scenario["version"] == 1
    assert scenario["rule_mode"] == "live_additive" and scenario["created_at"]
    assert client.get(f"/api/scenarios/{sid}/rules").json() == []
    effective = client.get(f"/api/scenarios/{sid}/effective-rules").json()
    assert effective == [{"rule": actual, "origin": "actual", "editable": False}]
    for extra in (
        {"fork_date": "2026-02-01"},
        {"base_scenario_id": 1},
        {"status": "archived"},
    ):
        assert (
            client.patch(
                f"/api/scenarios/{sid}",
                json={"name": "x", "description": "", "version": 1, **extra},
            ).status_code
            == 422
        )
    for name, day in ((" ", DAY), ("future", "2999-01-01")):
        assert (
            client.post(
                "/api/scenarios", json={"name": name, "fork_date": day}
            ).status_code
            == 422
        )


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("patch", "", {"name": "x", "version": 1}),
        ("post", "/archive", {"version": 1}),
        ("post", "/restore", {"version": 1}),
        ("delete", "", None),
        ("get", "/deletion-impact", None),
        ("get", "/legacy-rule-resolution", None),
    ],
)
def test_actual_protection_and_missing_precedence(client, method, path, body):
    for sid, expected in ((1, 400), (999, 404)):
        result = client.request(method, f"/api/scenarios/{sid}{path}", json=body)
        assert result.status_code == expected, result.text
        assert result.json()["detail"]["code"] == (
            "actual_scenario_protected" if sid == 1 else "scenario_not_found"
        )


def test_state_idempotence_guard_order_and_version(client):
    scenario = create(client)
    path = f"/api/scenarios/{scenario['id']}"
    edited = client.patch(
        path, json={"name": "변경", "description": "new", "version": 1}
    ).json()
    assert edited["version"] == 2
    assert (
        edited["fork_date"] == scenario["fork_date"]
        and edited["created_at"] == scenario["created_at"]
    )
    assert client.patch(path, json={"name": "stale", "version": 1}).status_code == 409
    archived = client.post(path + "/archive", json={"version": 2}).json()
    assert archived["version"] == 3 and archived["archived_at"]
    assert client.post(path + "/archive", json={"version": 1}).json() == archived
    failure = client.patch(path, json={"name": "stale", "version": 1})
    assert failure.json()["detail"]["code"] == "scenario_archived_read_only"
    assert not client.get("/api/scenarios").json()
    assert client.get("/api/scenarios?status=archived").json() == [archived]
    restored = client.post(path + "/restore", json={"version": 3}).json()
    assert restored["version"] == 4 and restored["archived_at"] is None
    assert client.post(path + "/restore", json={"version": 1}).json() == restored


@pytest.mark.parametrize(
    "header,status,code",
    [
        (None, 428, "scenario_version_required"),
        ("scenario-2-v2", 400, "invalid_scenario_version"),
        ('W/"scenario-2-v2"', 400, "invalid_scenario_version"),
        ("*", 400, "invalid_scenario_version"),
        ('"scenario-2-v2", "scenario-3-v2"', 400, "invalid_scenario_version"),
        ('"scenario-999-v2"', 412, "scenario_version_conflict"),
        ('"scenario-2-v1"', 412, "scenario_version_conflict"),
    ],
)
def test_delete_etag_contract(client, header, status, code):
    scenario = create(client)
    path = f"/api/scenarios/{scenario['id']}"
    assert client.delete(path).json()["detail"]["code"] == "scenario_state_conflict"
    client.post(path + "/archive", json={"version": 1})
    result = client.delete(path, headers={"If-Match": header} if header else {})
    assert result.status_code == status and result.json()["detail"]["code"] == code
    if status == 412:
        assert result.json()["detail"]["impact"]["version"] == 2
    assert client.get(path).status_code == 200


def test_nested_ownership_actual_only_and_version_once(client):
    scenario = create(client)
    other = create(client, "다른 계획")
    body = rule_body(client)
    path = f"/api/scenarios/{scenario['id']}"
    actual_body = {k: v for k, v in body.items() if k != "scenario_version"}
    actual = client.post("/api/rules", json=actual_body).json()
    assert (
        client.post(
            "/api/rules", json={**actual_body, "scenario_id": scenario["id"]}
        ).status_code
        == 422
    )
    assert client.get("/api/rules?scenario_id=2").status_code == 422
    assert client.get("/api/transactions?scenario_id=2").status_code == 422
    assert (
        client.post(
            "/api/transactions", json={"scenario_id": 2, "date": DAY, "postings": []}
        ).status_code
        == 422
    )
    saved = client.post(path + "/rules", json=body).json()
    assert saved["scenario_version"] == 2
    rid = saved["rule"]["id"]
    assert client.delete(f"/api/rules/{rid}").status_code == 404
    assert client.put(f"/api/rules/{rid}", json=actual_body).status_code == 404
    for foreign in (actual["id"], rid):
        result = client.put(f"/api/scenarios/{other['id']}/rules/{foreign}", json=body)
        assert result.status_code == 404
    assert client.post(path + "/rules", json=body).status_code == 409
    assert client.get(path).json()["version"] == 2
    updated = client.put(
        path + f"/rules/{rid}", json={**body, "amount": 200, "scenario_version": 2}
    ).json()
    assert updated["scenario_version"] == 3
    deleted = client.delete(
        path + f"/rules/{rid}", headers={"If-Match": f'"scenario-{scenario["id"]}-v3"'}
    ).json()
    assert deleted["scenario_version"] == 4
    assert client.get("/api/rules").json() == [actual]


@pytest.mark.parametrize("stage", ["bump", "child"])
def test_rule_mutation_rollback(client, stage):
    scenario = create(client)
    body = rule_body(client)
    conn = connect(client.app.state.db_path)
    before = state(conn)
    trigger = (
        "AFTER UPDATE OF version ON scenarios"
        if stage == "bump"
        else "AFTER INSERT ON recurring_rules"
    )
    conn.execute(
        f"CREATE TRIGGER injected {trigger} BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    result = client.post(f"/api/scenarios/{scenario['id']}/rules", json=body)
    assert result.status_code == 400
    assert state(conn) == before
    conn.execute("DROP TRIGGER injected")
    assert (
        client.post(f"/api/scenarios/{scenario['id']}/rules", json=body).json()[
            "scenario_version"
        ]
        == 2
    )
    conn.close()


@pytest.mark.parametrize(
    "stage", ["unpost", "postings", "transactions", "rules", "scenario"]
)
def test_delete_rolls_back_each_storage_boundary(client, stage):
    scenario = create(client)
    sid = scenario["id"]
    body = rule_body(client)
    client.post(f"/api/scenarios/{sid}/rules", json=body)
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute(
            "INSERT INTO transactions(id,scenario_id,date) VALUES(1,?, '2026-02-01')",
            (sid,),
        )
        conn.executemany(
            "INSERT INTO postings(txn_id,account_id,amount) VALUES(1,?,?)",
            [(body["from_account_id"], -200), (body["to_account_id"], 200)],
        )
        conn.execute("UPDATE transactions SET posted=1 WHERE id=1")
    client.post(f"/api/scenarios/{sid}/archive", json={"version": 2})
    before = state(conn)
    trigger = {
        "unpost": "AFTER UPDATE OF posted ON transactions",
        "postings": "AFTER DELETE ON postings",
        "transactions": "AFTER DELETE ON transactions",
        "rules": "AFTER DELETE ON recurring_rules",
        "scenario": "AFTER DELETE ON scenarios",
    }[stage]
    conn.execute(
        f"CREATE TRIGGER injected {trigger} BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    impact = client.get(f"/api/scenarios/{sid}/deletion-impact")
    assert impact.headers["etag"] == f'"scenario-{sid}-v3"'
    headers = {"If-Match": impact.headers["etag"]}
    assert client.delete(f"/api/scenarios/{sid}", headers=headers).status_code == 400
    assert state(conn) == before
    conn.execute("DROP TRIGGER injected")
    result = client.delete(f"/api/scenarios/{sid}", headers=headers)
    assert result.json() == {
        "deleted": sid,
        "rules": 1,
        "planned_transactions": 1,
        "generated_transactions": 0,
        "postings": 2,
    }
    assert client.get(f"/api/scenarios/{sid}").status_code == 404
    assert [tuple(r) for r in conn.execute("SELECT * FROM scenarios")] == [
        before["scenarios"][0]
    ]
    conn.close()


def test_same_version_has_one_winner(client):
    scenario = create(client)
    ready = Barrier(2)

    def writer(name):
        conn = connect(client.app.state.db_path)
        try:
            ready.wait(timeout=5)
            try:
                return service.edit_scenario(
                    scenario["id"], name, "", 1, SqliteUnitOfWork(conn)
                ).version
            except DomainConflictError as error:
                return error.code
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(writer, ["one", "two"]))
    assert set(results) == {2, "scenario_version_conflict"}


def test_legacy_resolution_complete_stale_and_actual_candidates_not_versioned(client):
    scenario = create(client)
    sid = scenario["id"]
    body = rule_body(client)
    rid = client.post(f"/api/scenarios/{sid}/rules", json=body).json()["rule"]["id"]
    actual_body = {k: v for k, v in body.items() if k != "scenario_version"}
    actual = client.post("/api/rules", json=actual_body).json()
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute(
            "UPDATE scenarios SET rule_mode='legacy_snapshot' WHERE id=?", (sid,)
        )
        for tid, source in ((1, rid), (2, None)):
            conn.execute(
                "INSERT INTO transactions(id,scenario_id,date,source_rule_id) VALUES(?,?,?,?)",
                (tid, sid, DAY, source),
            )
            conn.executemany(
                "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
                [
                    (tid, body["from_account_id"], -100),
                    (tid, body["to_account_id"], 100),
                ],
            )
            conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (tid,))
    path = f"/api/scenarios/{sid}/legacy-rule-resolution"
    info = client.get(path).json()
    assert (
        info["generated_transactions"] == 1 and len(info["transaction_conflicts"]) == 1
    )
    assert (
        client.get(f"/api/projection?scenario_id={sid}").json()["detail"]["code"]
        == "legacy_rule_resolution_required"
    )
    assert (
        client.post(
            f"/api/scenarios/{sid}/rules", json={**body, "scenario_version": 2}
        ).status_code
        == 409
    )
    incomplete = {"version": 2, "rule_decisions": [], "transaction_decisions": []}
    before = state(conn)
    assert client.post(path, json=incomplete).status_code == 409
    assert state(conn) == before
    complete = {
        "version": 2,
        "rule_decisions": [{"legacy_rule_id": rid, "action": "keep_as_scenario"}],
        "transaction_decisions": [
            {"transaction_id": 2, "action": "move", "date": "2026-02-01"}
        ],
    }
    assert (
        client.post(path, json={**complete, "version": 1}).json()["detail"]["code"]
        == "legacy_rule_resolution_stale"
    )
    client.put(f"/api/rules/{actual['id']}", json={**actual_body, "amount": 300})
    result = client.post(path, json=complete)
    assert result.status_code == 200, result.text
    assert result.json()["scenario"]["version"] == 3
    assert (
        result.json()["removed_transactions"] == 1
        and result.json()["moved_transactions"] == 1
    )
    assert (
        conn.execute("SELECT date FROM transactions WHERE id=2").fetchone()[0]
        == "2026-02-01"
    )
    assert client.get(f"/api/projection?scenario_id={sid}").status_code == 200
    conn.close()


def test_deleted_identity_and_etag_never_apply_to_replacement(client):
    first = create(client)
    path = f"/api/scenarios/{first['id']}"
    client.post(path + "/archive", json={"version": 1})
    old = client.get(path + "/deletion-impact").headers["etag"]
    assert client.delete(path, headers={"If-Match": old}).status_code == 200
    second = create(client, "replacement")
    assert second["id"] > first["id"]
    client.post(f"/api/scenarios/{second['id']}/archive", json={"version": 1})
    assert client.delete(path, headers={"If-Match": old}).status_code == 404
    assert (
        client.delete(
            f"/api/scenarios/{second['id']}", headers={"If-Match": old}
        ).status_code
        == 412
    )
    assert client.patch(path, json={"name": "stale", "version": 1}).status_code == 404


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("stage", ["version", "child"])
def test_rule_update_delete_roll_back(client, method, stage):
    scenario = create(client)
    body = rule_body(client)
    path = f"/api/scenarios/{scenario['id']}/rules"
    saved = client.post(path, json=body).json()
    path += f"/{saved['rule']['id']}"
    conn = connect(client.app.state.db_path)
    before = state(conn)
    boundary = (
        "AFTER UPDATE OF version ON scenarios"
        if stage == "version"
        else "AFTER UPDATE ON recurring_rules"
        if method == "put"
        else "AFTER DELETE ON recurring_rules"
    )
    conn.execute(
        f"CREATE TRIGGER injected {boundary} BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    kwargs = (
        {"json": {**body, "amount": 999, "scenario_version": 2}}
        if method == "put"
        else {"headers": {"If-Match": f'"scenario-{scenario["id"]}-v2"'}}
    )
    assert client.request(method, path, **kwargs).status_code == 400
    assert state(conn) == before
    conn.execute("DROP TRIGGER injected")
    assert client.request(method, path, **kwargs).json()["scenario_version"] == 3
    conn.close()


@pytest.mark.parametrize(
    "stage", ["version", "unpost", "posting", "transaction", "move", "rule"]
)
def test_legacy_conversion_rollback_matrix(client, stage):
    scenario = create(client)
    unrelated = create(client, "unrelated")
    body = rule_body(client)
    sid = scenario["id"]
    rid = client.post(f"/api/scenarios/{sid}/rules", json=body).json()["rule"]["id"]
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute(
            "UPDATE scenarios SET rule_mode='legacy_snapshot' WHERE id=?", (sid,)
        )
        for tid, owner, source in (
            (1, sid, rid),
            (2, sid, None),
            (3, 1, None),
            (4, unrelated["id"], None),
        ):
            conn.execute(
                "INSERT INTO transactions(id,scenario_id,date,source_rule_id) VALUES(?,?,?,?)",
                (tid, owner, DAY, source),
            )
            conn.executemany(
                "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
                [
                    (tid, body["from_account_id"], -100),
                    (tid, body["to_account_id"], 100),
                ],
            )
            conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (tid,))
    before = state(conn)
    boundary = {
        "version": "AFTER UPDATE OF version ON scenarios",
        "unpost": "AFTER UPDATE OF posted ON transactions",
        "posting": "AFTER DELETE ON postings",
        "transaction": "AFTER DELETE ON transactions",
        "move": "AFTER UPDATE OF date ON transactions",
        "rule": "AFTER DELETE ON recurring_rules",
    }[stage]
    conn.execute(
        f"CREATE TRIGGER injected {boundary} BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    path = f"/api/scenarios/{sid}/legacy-rule-resolution"
    decisions = {
        "version": 2,
        "rule_decisions": [{"legacy_rule_id": rid, "action": "discard_snapshot"}],
        "transaction_decisions": [
            {"transaction_id": 2, "action": "move", "date": "2026-02-01"}
        ],
    }
    assert client.post(path, json=decisions).status_code == 400
    assert state(conn) == before
    conn.execute("DROP TRIGGER injected")
    success = client.post(path, json=decisions)
    assert success.json()["scenario"]["version"] == 3
    assert (
        success.json()["removed_rules"] == 1
        and success.json()["removed_transactions"] == 1
    )
    assert [
        tuple(r)
        for r in conn.execute(
            "SELECT * FROM transactions WHERE scenario_id IN (1,?) ORDER BY id",
            (unrelated["id"],),
        )
    ] == [row for row in before["transactions"] if row[1] in (1, unrelated["id"])]
    assert state(conn)["calculation_revisions"] == before["calculation_revisions"]
    assert client.post(path, json=decisions).status_code == 409
    conn.close()


def test_hundred_scenario_list_uses_stable_order_and_one_query(client):
    from moneymap.adapters.sqlite.scenarios import ScenarioWriter

    conn = connect(client.app.state.db_path)
    with conn:
        conn.executemany(
            "INSERT INTO scenarios(name,base_scenario_id,fork_date,created_at) VALUES(?,1,'2026-01-31','2026-01-31 00:00:00')",
            [(f"list-{n}",) for n in range(100)],
        )
    statements = []
    conn.set_trace_callback(statements.append)
    scenarios = ScenarioWriter(conn).list_all("active")
    assert len(scenarios) == 100
    assert [s.id for s in scenarios] == sorted((s.id for s in scenarios), reverse=True)
    assert len(statements) == 1
    conn.close()
    response = client.get("/api/scenarios?status=active")
    assert response.status_code == 200
    assert len(response.json()) == 100
