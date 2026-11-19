"""Use a real v11 file and freeze only SQLite's clock on the migration connection."""
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, database, init_db
from moneymap.api import create_app
from fixtures.account_history_ledger import migrate_in_may, seed_v11


@pytest.fixture
def ledger(tmp_path):
    path = tmp_path / "history.db"
    seed_v11(path)
    migrate_in_may(path)
    with TestClient(create_app(str(path))) as client:
        yield path, client


def history(client, aid=2):
    return client.get(f"/api/accounts/{aid}/state-history").json()


def post(day, aid=2):
    return {"date": day, "postings": [{"account_id": aid, "amount": -23}, {"account_id": 3, "amount": 23}]}


def act(client, action, day, aid=2):
    response = client.post(f"/api/accounts/{aid}/{action}", params={"effective_date": day})
    assert response.status_code == 200, response.text


def correct(client, event, day):
    return client.post(f"/api/accounts/{event['account_id']}/state-history/{event['seq']}/corrections",
                       json={"effective_date": day, "expected_revision": event["revision"]})


def test_upgrade_rollback_backup_and_restart(tmp_path):
    path = tmp_path / "old.db"
    seed_v11(path)
    conn = connect(str(path))

    def fail(c):
        database.migrate_account_history(c)
        raise RuntimeError("after baseline")

    with patch.object(database, "MIGRATIONS", (*database.MIGRATIONS[:11], fail)):
        with pytest.raises(RuntimeError, match="after baseline"):
            init_db(conn)
    with connect(str(path)) as observer:
        assert observer.execute("PRAGMA user_version").fetchone()[0] == 11
        assert observer.execute("SELECT count(*) FROM sqlite_master WHERE name LIKE 'account_state_%'").fetchone()[0] == 0
    conn.close()
    migrate_in_may(path)
    with connect(str(path)) as observer:
        init_db(observer)
        assert observer.total_changes == 0
        assert observer.execute("SELECT count(*) FROM account_state_events WHERE action='baseline'").fetchone()[0] == 6
        assert observer.execute("PRAGMA foreign_key_check").fetchall() == []
        assert [tuple(r) for r in observer.execute("SELECT id,txn_id,account_id,amount FROM postings ORDER BY id")] == [(41,31,2,-500),(42,31,3,500)]
    with connect(str(next((tmp_path / "backups").glob("migration-*.db")))) as backup:
        assert backup.execute("PRAGMA user_version").fetchone()[0] == 11
        assert backup.execute("SELECT count(*) FROM postings").fetchone()[0] == 2


def test_dates_order_correction_and_existing_references(ledger):
    _, client = ledger
    act(client, "archive", "2020-06-01")
    # Unknown uses the current state. Only the original row may keep this account.
    rows = client.get("/api/accounts?on=2020-05-01").json()
    assert all(row["history_known"] is False for row in rows)
    assert client.post("/api/transactions", json=post("2020-05-01")).status_code == 400
    detail = client.get("/api/transactions/31").json()
    edit = {k: detail[k] for k in ["date","description","tags"]}
    edit.update(memo="기존 연결", expected_version=detail["version"], request_id=str(uuid4()),
                postings=[{k:p[k] for k in ("posting_id","account_id","amount")} for p in detail["postings"]])
    assert client.put("/api/transactions/31", json=edit).json()["transaction"]["postings"] == detail["postings"]
    saved = client.post("/api/transactions", json={**post("2020-05-31"), "description":"기억"}).json()
    assert saved["postings"][0]["account_id"] == 2
    for day in range(1,5):
        assert client.post("/api/transactions", json=post(f"2020-06-{day:02}")).json()["detail"]["code"] == "account_unavailable"
    act(client, "restore", "2020-06-05")
    assert client.post("/api/transactions", json=post("2020-06-05")).status_code == 201
    assert client.post("/api/transactions", json=post("2020-05-01")).status_code == 201
    recall = "/api/transaction-input/last-pair?item=기억&on="
    assert client.get(recall+"2020-06-04").json()["status"] == "unavailable"
    assert client.get(recall+"2020-05-31").json()["status"] == "matched"
    original = next(e for e in history(client)["events"] if e["action"] == "archive")
    assert original["applied_at"] == "2020-05-31T15:00:00.000Z"
    assert original["recorded_at"] > original["applied_at"]
    assert correct(client, original, "2020-06-03").status_code == 200
    assert correct(client, original, "2020-06-04").status_code == 409
    assert client.post("/api/transactions", json=post("2020-06-01")).status_code == 201
    assert client.post("/api/transactions", json=post("2020-06-03")).status_code == 400
    events = history(client)["events"]
    corrected = next(e for e in events if e["action"] == "archive")
    assert corrected["seq"] == original["seq"] and corrected["effective_at"] == original["effective_at"]
    assert correct(client, corrected, "2020-06-06").status_code == 409
    assert correct(client, corrected, "2020-06-05").status_code == 200
    assert client.post("/api/transactions", json=post("2020-06-05")).status_code == 201
    data = history(client)
    assert len(data["corrections"]) == 2
    # Archive and restore at the identical instant have no intervening interval.
    assert data["intervals"] == [{"start":data["started_at"],"end":None,"reason":"postable"}]
    assert correct(client, events[0], "2020-05-16").status_code == 400


def test_reparent_and_parent_group_change_share_effective_time(ledger):
    _, client = ledger
    settings = dict(name="이동할 계정", parent_id=5, is_overdraft=False, version=1, effective_date="2020-06-02")
    result = client.put("/api/accounts/6/settings", json=settings).json()
    assert result["effects"]["source_parent_grouped"] is True
    move = next(e for e in history(client, 6)["events"] if e["action"] == "reparent")
    assert move["before_state"]["parent_id"] == 4 and move["after_state"]["parent_id"] == 5
    assert move["seq"] in [e["seq"] for e in history(client, 5)["events"]]
    group = next(e for e in history(client, 4)["events"] if e["action"] == "group")
    assert group["batch"] == move["batch"]
    assert correct(client, move, "2020-06-04").status_code == 200
    for day, parent, placeholder in [(3,4,False),(4,5,True)]:
        accounts = {r["id"]:r for r in client.get(f"/api/accounts?on=2020-06-0{day}").json()}
        assert accounts[6]["parent_id"] == parent and accounts[4]["is_placeholder"] is placeholder
        assert client.post("/api/transactions", json=post(f"2020-06-0{day}",4)).json()["detail"]["code"] == "account_not_postable"
    response = client.post("/api/accounts/4/placeholder?effective_date=2020-06-05", json={"is_placeholder":False})
    assert response.is_success
    assert [i["reason"] for i in history(client, 4)["intervals"]] == ["group", "postable"]
    assert client.post("/api/transactions", json=post("2020-06-05",4)).status_code == 201


def test_log_failure_rolls_back_both_accounts_and_retry_logs_once(ledger):
    path, client = ledger
    with connect(str(path)) as writer:
        writer.execute("""CREATE TRIGGER fail_parent BEFORE INSERT ON account_state_events
            WHEN NEW.action='group' BEGIN SELECT RAISE(ABORT,'injected journal failure'); END""")
    data = dict(name="이동", parent_id=5, is_overdraft=False, version=1)
    assert client.put("/api/accounts/6/settings", json=data).status_code == 400
    with connect(str(path)) as observer:
        assert tuple(observer.execute("SELECT name,parent_id,version FROM accounts WHERE id=6").fetchone()) == ("이동할 계정",4,1)
        assert tuple(observer.execute("SELECT is_placeholder,version FROM accounts WHERE id=4").fetchone()) == (0,1)
        assert observer.execute("SELECT count(*) FROM account_state_events WHERE action!='baseline'").fetchone()[0] == 0
        assert observer.execute("SELECT count(*) FROM account_action_context").fetchone()[0] == 0
        observer.execute("DROP TRIGGER fail_parent")
    assert client.put("/api/accounts/6/settings", json=data).is_success
    with connect(str(path)) as observer:
        assert [r[0] for r in observer.execute("SELECT action FROM account_state_events WHERE action!='baseline' ORDER BY seq")] == ["reparent","group"]


def test_intraday_order_and_backdated_edit_check_row_identity(ledger):
    _, client = ledger
    # Both actions happen today after midnight. Day-close selection follows seq.
    for action in ("archive", "restore"):
        assert client.post(f"/api/accounts/2/{action}").is_success
    from datetime import datetime
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo("Asia/Seoul")).date().isoformat()
    assert client.post("/api/transactions", json=post(today)).is_success
    archive, restore = history(client)["events"][-2:]
    assert archive["seq"] < restore["seq"]
    assert correct(client, archive, "2020-06-01").is_success
    assert correct(client, restore, "2020-06-05").is_success
    original = client.get("/api/transactions/31").json()
    command = dict(date="2020-06-03", description="원래 분개", memo="", tags=[],
                   expected_version=original["version"], request_id=str(uuid4()),
                   postings=[{"account_id":2,"amount":-500},{"posting_id":42,"account_id":3,"amount":500}])
    rejected = client.put("/api/transactions/31", json=command)
    assert rejected.json()["detail"]["code"] == "account_unavailable"
    command["postings"][0]["posting_id"] = 41
    assert client.put("/api/transactions/31", json=command).json()["transaction"]["postings"] == original["postings"]
    assert client.post("/api/accounts/2/opening-balance", json={"date":"2020-06-03","amount":1,"state":"positive"}).json()["detail"]["code"] == "account_unavailable"


def test_creation_and_parent_eligibility_across_corrections(ledger):
    _, client = ledger
    # Child creation makes a previously postable parent an implicit group.
    child = client.post("/api/accounts", json={"name":"뒤늦게 등록한 자식","type":"asset","parent_id":2}).json()
    event = history(client, child["id"])["events"][0]
    assert correct(client, event, "2020-06-03").is_success
    assert client.post("/api/transactions", json=post("2020-06-02",child["id"])).json()["detail"]["code"] == "account_unavailable"
    assert client.post("/api/transactions", json=post("2020-06-02")).is_success
    assert client.post("/api/transactions", json=post("2020-06-03")).json()["detail"]["code"] == "account_not_postable"
    assert client.post("/api/transactions", json=post("2020-06-03",child["id"])).is_success
    act(client, "archive", "2020-06-04", child["id"])
    act(client, "archive", "2020-06-05")
    parent_archive = history(client)["events"][-1]
    assert [i["reason"] for i in history(client, child["id"])["intervals"]] == ["not_created", "postable", "archived"]
    assert correct(client, parent_archive, "2020-06-03").json()["detail"]["code"] == "account_history_order"
    assert correct(client, parent_archive, "0001-01-01").json()["detail"]["code"] == "account_history_range"
    assert client.post("/api/accounts/2/restore?effective_date=9999-12-31").json()["detail"]["code"] == "account_history_range"
    assert client.get("/api/accounts/99999/state-history").status_code == 404
    assert client.get("/api/accounts?on=0001-01-01").json()[0]["history_known"] is False
