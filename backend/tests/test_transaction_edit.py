"""Edit the real SQLite ledger in isolated fixtures, including ambiguous writes."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest

from moneymap.adapters.sqlite import connect
from moneymap.adapters.sqlite.transaction_edit import update_transaction
from moneymap.domain.errors import DomainConflictError, DomainUnavailableError
from moneymap.domain.transaction_edit import TransactionEdit
from test_api import client, make_account, make_opening_balance, TODAY


def detail(client, tid):
    response = client.get(f"/api/transactions/{tid}")
    assert response.status_code == 200, response.text
    return response.json()


def body(original, **changes):
    result = {k: original[k] for k in ("date", "description", "memo", "tags")}
    result.update(expected_version=original["version"], request_id=str(uuid4()))
    if original["kind"] == "regular":
        result["postings"] = [{k: p[k] for k in ("posting_id", "account_id", "amount")} for p in original["postings"]]
    else:
        p = next(p for p in original["postings"] if p["account_id"] != original["opening_system_id"])
        result["opening"] = {"account_id": p["account_id"], "signed_amount": p["amount"]}
    return {**result, **changes}


@pytest.fixture
def original(client):
    expense = make_account(client, "식비", "expense")
    cash = make_account(client, "현금", "asset")
    created = client.post("/api/transactions", json={"date": "2026-01-02", "description": "점심", "memo": "원래 메모", "tags": ["일상"],
        "postings": [{"account_id": expense, "amount": 100}, {"account_id": cash, "amount": -100}]})
    assert created.status_code == 201, created.text
    return detail(client, created.json()["id"])


def put(client, original, command):
    return client.put(f"/api/transactions/{original['id']}", json=command)


def resolve(client, original, command):
    return client.post(f"/api/transactions/{original['id']}/edit-result", json=command)


def test_full_edit_preserves_ids_and_origin_and_updates_balance(client, original):
    command = body(original, date="2026-02-03", description="저녁", memo="새 메모\n둘째 줄", tags=[" 데이트 ", "선물", "데이트"])
    for p in command["postings"]:
        p["amount"] *= 2
    response = put(client, original, command)
    assert response.status_code == 200, response.text
    saved = detail(client, original["id"])
    assert saved["version"] != original["version"]
    assert saved["entry_origin"] == original["entry_origin"]
    assert saved["description"] == "저녁" and saved["date"] == "2026-02-03"
    assert saved["memo"] == command["memo"] and set(saved["tags"]) == {"데이트", "선물"}
    assert [p["posting_id"] for p in saved["postings"]] == [p["posting_id"] for p in original["postings"]]
    assert sum(p["amount"] for p in saved["postings"]) == 0
    balances = client.get("/api/balances").json()["accounts"]
    assert next(a for a in balances if a["account_id"] == original["postings"][1]["account_id"])["balance"] == -200
    assert response.json()["result_version"] == saved["version"]


@pytest.mark.parametrize("mutation", ["unbalanced", "zero", "duplicate_id", "foreign_id", "new_system", "extra_source", "currency", "amount_type", "too_many", "bad_date", "huge", "bad_tag"])
def test_invalid_edit_rolls_back(client, original, mutation):
    command = body(original)
    p = command["postings"][0]
    if mutation == "unbalanced": p["amount"] += 1
    if mutation == "zero":
        for posting in command["postings"]: posting["amount"] = 0
    if mutation == "duplicate_id": command["postings"][1]["posting_id"] = p["posting_id"]
    if mutation == "foreign_id": p["posting_id"] = 999999
    if mutation == "new_system": p["account_id"] = next(a["id"] for a in client.get("/api/accounts").json() if a["is_system"])
    if mutation == "extra_source": command["source_rule_id"] = 42
    if mutation == "currency": p["currency"] = "USD"
    if mutation == "amount_type": p["amount"] = "100"
    if mutation == "too_many": command["postings"] *= 51
    if mutation == "bad_date": command["date"] = "2026-02-30"
    if mutation == "huge": p["amount"] = 9007199254740992
    if mutation == "bad_tag": command["tags"] = [" "]
    assert put(client, original, command).status_code in (400, 422)
    assert detail(client, original["id"]) == original


def test_split_add_remove_and_replace_account(client, original):
    command = body(original)
    new_account = make_account(client, "교통", "expense")
    command["postings"][0]["amount"] = 40
    command["postings"].append({"account_id": new_account, "amount": 60})
    assert put(client, original, command).status_code == 200
    three = detail(client, original["id"])
    assert len(three["postings"]) == 3
    command = body(three)
    command["postings"] = command["postings"][:2]
    command["postings"][0].update(account_id=new_account, amount=100)
    assert put(client, original, command).status_code == 200
    two = detail(client, original["id"])
    assert len(two["postings"]) == 2 and two["postings"][0]["posting_id"] == original["postings"][0]["posting_id"]


@pytest.mark.parametrize("state", ["archived", "group"])
def test_retained_accounts_allowed_but_exception_cannot_move_to_new_row(client, original, state):
    aid = original["postings"][0]["account_id"]
    if state == "archived":
        assert client.post(f"/api/accounts/{aid}/archive").status_code == 200
    else:
        assert client.post("/api/accounts", json={"name": "하위", "type": "expense", "parent_id": aid}).status_code == 201
    assert put(client, original, body(original, memo="과거 계정 유지")).status_code == 200
    updated = detail(client, original["id"])
    command = body(updated)
    command["postings"][0].pop("posting_id")
    assert put(client, updated, command).status_code == 400
    assert detail(client, original["id"]) == updated


def test_legacy_zero_preserved_then_corrected_and_not_recreated(client, original):
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute("UPDATE transactions SET posted=0 WHERE id=?", (original["id"],))
        conn.execute("UPDATE postings SET amount=0 WHERE txn_id=?", (original["id"],))
        conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (original["id"],))
    conn.close()
    zero = detail(client, original["id"])
    assert put(client, zero, body(zero, memo="0원 보존")).status_code == 200
    zero = detail(client, original["id"])
    command = body(zero)
    command["postings"][0]["amount"], command["postings"][1]["amount"] = 50, -50
    assert put(client, zero, command).status_code == 200
    nonzero = detail(client, original["id"])
    command = body(nonzero)
    for p in command["postings"]: p["amount"] = 0
    assert put(client, nonzero, command).status_code == 400


def test_opening_edit_and_duplicate_protection(client):
    a, b = make_account(client, "계좌A", "asset"), make_account(client, "계좌B", "asset")
    original = detail(client, make_opening_balance(client, a, 100).json()["id"])
    assert original["kind"] == "opening"
    command = body(original, description="이름 바꿔도 개시잔액", opening={"account_id": b, "signed_amount": 200})
    assert put(client, original, command).status_code == 200
    saved = detail(client, original["id"])
    assert saved["kind"] == "opening" and saved["opening_system_id"] == original["opening_system_id"]
    assert {p["posting_id"] for p in saved["postings"]} == {p["posting_id"] for p in original["postings"]}
    other = detail(client, make_opening_balance(client, a, 20).json()["id"])
    assert put(client, other, body(other, opening={"account_id": b, "signed_amount": 10})).status_code == 409
    assert put(client, saved, body(saved, opening={"account_id": b, "signed_amount": 0})).status_code == 400
    malformed = body(saved)
    malformed.pop("opening")
    malformed["postings"] = [{k: p[k] for k in ("posting_id", "account_id", "amount")} for p in saved["postings"]]
    assert put(client, saved, malformed).status_code == 400


def test_old_version_rejected_and_new_numeric_id_is_not_old_transaction(client, original):
    assert put(client, original, body(original, memo="다른 창")).status_code == 200
    assert put(client, original, body(original, memo="오래된 창")).status_code == 409
    assert client.delete(f"/api/transactions/{original['id']}").status_code == 200
    assert client.get(f"/api/transactions/{original['id']}").status_code == 404
    recreated = client.post("/api/transactions", json={"date": original["date"], "postings": [{"account_id": p["account_id"], "amount": p["amount"]} for p in original["postings"]]}).json()
    assert recreated["id"] == original["id"]  # INTEGER PRIMARY KEY can reuse the last ID.
    assert put(client, original, body(original)).status_code == 409


def test_receipt_is_atomic_idempotent_and_survives_later_changes_and_delete(client, original):
    command = body(original, memo="처리 완료")
    first = put(client, original, command).json()
    assert first["outcome"] == "applied"
    assert put(client, original, command).json() == first
    assert resolve(client, original, command).json() == first
    assert put(client, original, {**command, "memo": "번호 재사용"}).status_code == 409
    assert put(client, original, body(first["transaction"], memo="다음 수정")).status_code == 200
    result = resolve(client, original, command).json()
    assert result["outcome"] == "applied" and result["transaction"]["version"] != result["result_version"]
    client.delete(f"/api/transactions/{original['id']}")
    assert resolve(client, original, command).json()["transaction"] is None


def test_resolve_before_delayed_save_seals_not_applied(client, original):
    command = body(original, memo="아직 도착하지 않은 저장")
    result = resolve(client, original, command)
    assert result.status_code == 200 and result.json()["outcome"] == "not_applied"
    assert resolve(client, original, command).json() == result.json()
    assert put(client, original, command).json()["outcome"] == "not_applied"
    assert detail(client, original["id"]) == original
    assert put(client, original, {**command, "request_id": str(uuid4())}).json()["outcome"] == "applied"


def test_mid_write_failure_rolls_back_fields_rows_tags_revision_and_receipt(client, original, monkeypatch):
    import moneymap.adapters.sqlite.transaction_edit as adapter
    replace = adapter._replace_tags
    def fail(conn, tid, tags):
        replace(conn, tid, tags)
        raise RuntimeError("injected after tags")
    monkeypatch.setattr(adapter, "_replace_tags", fail)
    command = body(original, memo="실패", tags=["새 태그"])
    with pytest.raises(RuntimeError, match="injected"):
        put(client, original, command)
    assert detail(client, original["id"]) == original
    assert resolve(client, original, command).json()["outcome"] == "not_applied"
    conn = connect(client.app.state.db_path)
    assert conn.execute("SELECT count(*) FROM tags WHERE name='새 태그'").fetchone()[0] == 0
    conn.close()


def test_concurrent_versions_only_one_succeeds_and_busy_is_translated(client, original):
    def update(memo):
        conn = connect(client.app.state.db_path)
        try:
            return update_transaction(conn, original["id"], TransactionEdit(**body(original, memo=memo)))["outcome"]
        except DomainConflictError:
            return "conflict"
        finally:
            conn.close()
    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(update, ["창1", "창2"])) == ["applied", "conflict"]
    first, second = connect(client.app.state.db_path), connect(client.app.state.db_path)
    try:
        first.execute("BEGIN IMMEDIATE")
        second.execute("PRAGMA busy_timeout=1")
        with pytest.raises(DomainUnavailableError):
            update_transaction(second, original["id"], TransactionEdit(**body(original)))
        assert not second.in_transaction
    finally:
        first.rollback(); first.close(); second.close()


def test_non_krw_and_non_actual_are_not_modified(client, original):
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute("UPDATE transactions SET posted=0 WHERE id=?", (original["id"],))
        conn.execute("UPDATE postings SET currency='USD' WHERE txn_id=?", (original["id"],))
        conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (original["id"],))
    foreign = detail(client, original["id"])
    assert not foreign["editable"] and put(client, foreign, body(foreign)).status_code == 400
    assert detail(client, original["id"]) == foreign
    with conn:
        sid = conn.execute("INSERT INTO scenarios(name,base_scenario_id) VALUES('가정',1)").lastrowid
        conn.execute("UPDATE transactions SET scenario_id=? WHERE id=?", (sid, original["id"]))
    assert client.get(f"/api/transactions/{original['id']}").status_code == 404
    assert put(client, foreign, body(foreign)).status_code == 404
    conn.close()


def test_reclassification_and_rule_deletion_invalidate_open_drafts(client, original):
    aid = original["postings"][0]["account_id"]
    child = client.post("/api/accounts", json={"name": "하위식비", "type": "expense", "parent_id": aid}).json()["id"]
    from moneymap.adapters.sqlite.accounts import SqliteAccountRepository
    conn = connect(client.app.state.db_path)
    SqliteAccountRepository(conn).reclassify_direct(aid, child)
    conn.close()
    assert put(client, original, body(original)).status_code == 409
    rule = client.post("/api/rules", json={"from_account_id": original["postings"][1]["account_id"], "to_account_id": child,
        "amount": 300, "schedule": "monthly:1", "start_date": TODAY.replace(day=1).isoformat()}).json()
    client.post("/api/materialize")
    generated = next(t for t in client.get("/api/transactions").json() if t["source_rule_id"] == rule["id"])
    before = detail(client, generated["id"])
    rules_before = client.get("/api/rules").json()
    cmd = body(before, date="2020-01-01", memo="이번 거래만")
    assert put(client, before, cmd).status_code == 200
    assert client.get("/api/rules").json() == rules_before
    assert client.post("/api/materialize").json()["created"] == 0
    updated = detail(client, before["id"])
    assert client.delete(f"/api/rules/{rule['id']}").status_code == 200
    assert put(client, updated, body(updated)).status_code == 409
    assert detail(client, updated["id"])["entry_origin"] == "rule"


def test_single_detail_query_count_is_bounded(client, original):
    from moneymap.adapters.sqlite.transaction_edit import find_detail
    conn = connect(client.app.state.db_path)
    traces = []
    conn.set_trace_callback(traces.append)
    assert find_detail(conn, original["id"])
    assert len(traces) == 3
    plan = conn.execute("EXPLAIN QUERY PLAN SELECT * FROM postings WHERE txn_id=?", (original["id"],)).fetchall()
    assert any("idx_postings_txn" in row[3] for row in plan)
    conn.close()


def test_import_edit_preserves_provenance_and_reimport_dedup(client, tmp_path):
    from test_legacy_import import _write_fixture
    from moneymap.legacy_import import import_legacy_csv
    source, classifications = _write_fixture(tmp_path)
    conn = connect(client.app.state.db_path)
    import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
    provenance = [tuple(row) for row in conn.execute("SELECT * FROM transaction_import_provenance ORDER BY txn_id")]
    imported = detail(client, provenance[0][0])
    assert put(client, imported, body(imported, description="현재 이름", memo="현재 메모")).status_code == 200
    assert [tuple(row) for row in conn.execute("SELECT * FROM transaction_import_provenance ORDER BY txn_id")] == provenance
    repeated = import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
    assert repeated["inserted"] == 0 and repeated["skipped_existing"] == 2
    conn.close()


@pytest.mark.parametrize("mixed", [False, True])
def test_reimport_preserves_edited_split_and_checks_only_new_posting_count(client, tmp_path, mixed):
    from test_legacy_import import _write_fixture
    from moneymap.legacy_import import import_legacy_csv
    source, classifications = _write_fixture(tmp_path)
    conn = connect(client.app.state.db_path)
    try:
        import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
        ids = [r[0] for r in conn.execute("SELECT txn_id FROM transaction_import_provenance ORDER BY txn_id")]
        original = detail(client, ids[0])
        command = body(original)
        command["postings"][0]["amount"] = 6000
        command["postings"].append({"account_id": original["postings"][0]["account_id"], "amount": 4000})
        assert put(client, original, command).status_code == 200
        edited = detail(client, ids[0])
        provenance = tuple(conn.execute("SELECT * FROM transaction_import_provenance WHERE txn_id=?", (ids[0],)).fetchone())
        if mixed:
            assert client.delete(f"/api/transactions/{ids[1]}").status_code == 200
        for apply in (False, True):
            result = import_legacy_csv(conn, source, classifications, apply=apply, expected_hash=None)
            assert result["inserted"] == int(mixed)
            assert result["skipped_existing"] == 2 - int(mixed)
            assert result["postings"] == 5 and result["imbalanced"] == 0
            assert detail(client, ids[0]) == edited
            assert tuple(conn.execute("SELECT * FROM transaction_import_provenance WHERE txn_id=?", (ids[0],)).fetchone()) == provenance
    finally:
        conn.close()


@pytest.mark.parametrize("method,suffix", [("put", ""), ("post", "/edit-result")])
@pytest.mark.parametrize("streamed", [False, True])
@pytest.mark.parametrize("id_prefix", ["", "+", "00"])
def test_edit_commands_have_preparse_body_limit(client, original, method, suffix, streamed, id_prefix):
    import json
    from moneymap.api import MAX_TRANSACTION_BODY_BYTES
    raw = b" " * MAX_TRANSACTION_BODY_BYTES + json.dumps(body(original)).encode()
    headers = {"Content-Type": "application/json"}
    if streamed:
        headers["Content-Length"] = "0"
    response = getattr(client, method)(f"/api/transactions/{id_prefix}{original['id']}{suffix}", content=raw, headers=headers)
    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "request_too_large"
    assert detail(client, original["id"]) == original
    conn = connect(client.app.state.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM transaction_edit_requests").fetchone()[0] == 0
    finally:
        conn.close()


@pytest.mark.parametrize("resolve_competes", [False, True])
def test_concurrent_identical_request_and_resolver_share_one_terminal_result(client, original, resolve_competes):
    from moneymap.adapters.sqlite.transaction_edit import resolve_edit
    command = TransactionEdit(**body(original, memo="동일 요청 경쟁"))
    barrier = Barrier(2)

    def run(resolve_request):
        conn = connect(client.app.state.db_path)
        try:
            barrier.wait()
            operation = resolve_edit if resolve_request else update_transaction
            return operation(conn, original["id"], command)
        finally:
            conn.close()

    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(run, [False, resolve_competes]))
    assert results[0] == results[1]
    saved = detail(client, original["id"])
    assert saved["memo"] == (command.memo if results[0]["outcome"] == "applied" else original["memo"])
    conn = connect(client.app.state.db_path)
    assert conn.execute("SELECT count(*) FROM transaction_edit_requests").fetchone()[0] == 1
    conn.close()


def test_two_openings_cannot_be_moved_to_same_account_concurrently(client):
    a, b, target = [make_account(client, name, "asset") for name in ("원래A", "원래B", "대상")]
    originals = [detail(client, make_opening_balance(client, aid, 100).json()["id"]) for aid in (a, b)]
    barrier = Barrier(2)

    def move(original):
        conn = connect(client.app.state.db_path)
        try:
            barrier.wait()
            return update_transaction(conn, original["id"], TransactionEdit(**body(original, opening={"account_id": target, "signed_amount": 100})))["outcome"]
        except DomainConflictError:
            return "conflict"
        finally:
            conn.close()

    with ThreadPoolExecutor(2) as pool:
        assert sorted(pool.map(move, originals)) == ["applied", "conflict"]
    openings = client.get("/api/opening-balances").json()
    assert len([o for o in openings if o["account_id"] == target]) == 1


def test_legacy_zero_opening_and_archived_target_remain_protected(client):
    aid = make_account(client, "과거 계좌", "asset")
    original = detail(client, make_opening_balance(client, aid, 100).json()["id"])
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute("UPDATE transactions SET posted=0 WHERE id=?", (original["id"],))
        conn.execute("UPDATE postings SET amount=0 WHERE txn_id=?", (original["id"],))
        conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (original["id"],))
    conn.close()
    zero = detail(client, original["id"])
    assert zero["kind"] == "legacy_opening_zero"
    client.post(f"/api/accounts/{aid}/archive")
    assert put(client, zero, body(zero, memo="0원 메모만 변경")).status_code == 200
    saved = detail(client, original["id"])
    assert saved["kind"] == "legacy_opening_zero"
    assert put(client, saved, body(saved, opening={"account_id": aid, "signed_amount": 150})).status_code == 200
    assert detail(client, original["id"])["kind"] == "opening"


def test_opening_sign_rules_and_new_target_type_are_checked(client):
    asset = make_account(client, "일반통장", "asset")
    liability = make_account(client, "부채", "liability")
    expense = make_account(client, "비용", "expense")
    original = detail(client, make_opening_balance(client, asset, 100).json()["id"])
    for target, amount in ((asset, -100), (liability, 100), (expense, 100)):
        assert put(client, original, body(original, opening={"account_id": target, "signed_amount": amount})).status_code == 400
        assert detail(client, original["id"]) == original
    assert put(client, original, body(original, opening={"account_id": liability, "signed_amount": -100})).status_code == 200


@pytest.mark.parametrize("target_type", ["expense", "income", "equity", "asset", "liability"])
def test_zero_opening_new_target_type_is_checked(client, target_type):
    aid = make_account(client, "과거 통장", "asset")
    tid = make_opening_balance(client, aid, 100).json()["id"]
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute("UPDATE transactions SET posted=0 WHERE id=?", (tid,))
        conn.execute("UPDATE postings SET amount=0 WHERE txn_id=?", (tid,))
        conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (tid,))
    conn.close()
    original = detail(client, tid)
    target = make_account(client, "새 대상", target_type)
    result = put(client, original, body(original, opening={"account_id": target, "signed_amount": 0}))
    if target_type in {"asset", "liability"}:
        assert result.status_code == 200, result.text
        assert {p["account_id"] for p in detail(client, tid)["postings"]} == {target, original["opening_system_id"]}
    else:
        assert result.status_code == 400
        assert result.json()["detail"]["code"] == "opening_invalid_account"
        assert detail(client, tid) == original


def test_edit_changes_actual_and_scenario_projection_at_their_existing_date_boundaries(client, original):
    scenario = client.post("/api/scenarios", json={"name": "분기", "fork_date": "2026-01-31"}).json()["scenario"]
    path = f"/api/projection?scenario_id={scenario['id']}&months=3"
    before = client.get(path).json()
    assert before["net_worth"]["baseline"]["points"][0]["balance"] == -100
    command = body(original, date="2026-02-03")
    for p in command["postings"]:
        p["amount"] *= 2
    assert put(client, original, command).status_code == 200
    after = client.get(path).json()
    assert after["net_worth"]["baseline"]["points"][0]["balance"] == 0
    assert after["basis"]["actual_ledger_revision"] > before["basis"]["actual_ledger_revision"]
    actual = client.get("/api/projection?scenario_id=1&months=3").json()
    assert actual["net_worth"]["baseline"]["points"][0]["balance"] == -200
    assert client.get("/api/status").json()["trial_balance_ok"] is True


def test_posting_id_from_another_transaction_cannot_authorize_retention(client, original):
    other = client.post("/api/transactions", json={"date": original["date"], "postings": [
        {"account_id": p["account_id"], "amount": p["amount"]} for p in original["postings"]]}).json()
    foreign = detail(client, other["id"])
    command = body(original)
    command["postings"][0]["posting_id"] = foreign["postings"][0]["posting_id"]
    assert put(client, original, command).status_code == 400
    assert detail(client, other["id"]) == foreign
    assert detail(client, original["id"]) == original
