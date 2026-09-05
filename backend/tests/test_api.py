"""FastAPI 어댑터 통합 테스트 — What-if 세로 슬라이스를 HTTP로 왕복."""

import datetime

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, init_db
from moneymap.api import create_app

TODAY = datetime.date.today()


@pytest.fixture
def client():
    app = create_app(":memory:")
    with TestClient(app) as c:  # with-블록이어야 lifespan(init_db)이 돈다
        yield c


def make_account(client, name: str, type_: str) -> int:
    res = client.post("/api/accounts", json={"name": name, "type": type_})
    assert res.status_code == 201, res.text
    return res.json()["id"]


def make_child_account(client, name: str, type_: str, parent_id: int) -> int:
    res = client.post(
        "/api/accounts",
        json={"name": name, "type": type_, "parent_id": parent_id},
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


def opening_account_id(client) -> int:
    accounts = client.get("/api/accounts").json()
    return next(a["id"] for a in accounts if a["type"] == "equity")


def account_by_name(client, name: str):
    return next(a for a in client.get("/api/accounts").json() if a["name"] == name)


def update_settings(client, account_id: int, **changes):
    account = next(
        a for a in client.get("/api/accounts").json() if a["id"] == account_id
    )
    body = {
        "name": account["name"],
        "parent_id": account["parent_id"],
        "is_overdraft": account["is_overdraft"],
        "version": account["version"],
        **changes,
    }
    return client.put(f"/api/accounts/{account_id}/settings", json=body)


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_vertical_slice_onboarding_to_projection(client):
    """온보딩 → 개시잔액 → 규칙 → materialize → 시나리오 fork → 비교 곡선."""
    # 1. 계정 생성
    toss = make_account(client, "Toss", "asset")
    salary = make_account(client, "월급", "income")
    saving = make_account(client, "적금", "asset")
    opening = opening_account_id(client)

    # 2. 개시잔액 = equity 상대 거래 (D4)
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "description": "개시잔액",
            "postings": [
                {"account_id": toss, "amount": 10_000_000},
                {"account_id": opening, "amount": -10_000_000},
            ],
        },
    )
    assert res.status_code == 201, res.text

    # 3. 반복 규칙 (월급) + materialize
    res = client.post(
        "/api/rules",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3_000_000,
            "schedule": "monthly:25",
            "start_date": TODAY.replace(day=1).isoformat(),
            "description": "월급",
        },
    )
    assert res.status_code == 201, res.text
    mat = client.post("/api/materialize").json()
    expected_created = 1 if TODAY.day >= 25 else 0
    assert mat["created"] == expected_created

    # 4. 잔액·순자산
    bal = client.get("/api/balances").json()
    expected_nw = 10_000_000 + expected_created * 3_000_000
    assert bal["net_worth"] == expected_nw

    # 5. 시나리오 fork (copy-on-fork 확인)
    res = client.post(
        "/api/scenarios",
        json={"name": "월 100만 더 저축", "fork_date": TODAY.isoformat()},
    )
    assert res.status_code == 201, res.text
    sc = res.json()["scenario"]
    assert res.json()["effective_actual_rules"] == 1
    assert client.get(f"/api/scenarios/{sc['id']}/rules").json() == []
    effective = client.get(f"/api/scenarios/{sc['id']}/effective-rules").json()
    assert effective[0]["origin"] == "actual" and not effective[0]["editable"]

    # 6. 시나리오에 가설 규칙 추가 (자산→자산 이체라 순자산 중립)
    client.post(
        f"/api/scenarios/{sc['id']}/rules",
        json={
            "scenario_version": sc["version"],
            "from_account_id": toss,
            "to_account_id": saving,
            "amount": 1_000_000,
            "schedule": "monthly:26",
            "start_date": TODAY.isoformat(),
            "description": "추가 저축",
        },
    )

    # 7. 프로젝션 — 시리즈 3종 (실제 / 기준선 / 시나리오)
    proj = client.get(
        "/api/dashboard-projection",
        params={"months": 12, "scenario_ids": str(sc["id"])},
    ).json()
    kinds = [s["kind"] for s in proj["series"]]
    assert kinds == ["actual", "baseline", "scenario"]

    actual, baseline, scenario = proj["series"]
    assert actual["points"][-1]["net_worth"] == expected_nw  # 실제는 오늘에서 끊김
    assert "basis" not in baseline  # No inferred variable-spend adjustment.
    # 1년 뒤: 기준선은 월급 12회 안팎으로 증가해야 한다
    assert baseline["points"][-1]["net_worth"] >= expected_nw + 11 * 3_000_000
    # 시나리오의 저축 이체는 순자산 중립 → 기준선과 최종값 동일
    assert scenario["points"][-1]["net_worth"] == baseline["points"][-1]["net_worth"]


def test_unbalanced_transaction_returns_400(client):
    toss = make_account(client, "Toss", "asset")
    food = make_account(client, "식비", "expense")
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "postings": [
                {"account_id": food, "amount": 52_000},
                {"account_id": toss, "amount": -50_000},
            ],
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "domain_error"
    assert "0이 아닙니다" in res.json()["detail"]["message"]


def test_account_parent_type_mismatch_returns_stable_conflict(client):
    a = make_account(client, "A", "asset")
    res = client.post(
        "/api/accounts", json={"name": "B", "type": "expense", "parent_id": a}
    )
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "account_parent_type_mismatch"


def test_projection_rejects_more_than_3_scenarios(client):
    res = client.get("/api/dashboard-projection", params={"scenario_ids": "2,3,4,5"})
    assert res.status_code == 400
    assert "최대 3개" in res.json()["detail"]["message"]


def test_seed_standard_accounts_builds_tree_and_is_idempotent(client):
    res = client.post("/api/accounts/seed-standard")
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 30  # 개시잔액은 init_db가 이미 시드

    accounts = client.get("/api/accounts").json()
    assert len(accounts) == 31
    by_name = {a["name"]: a for a in accounts}
    for group_name in [
        "입출금통장",
        "저축·적금",
        "투자",
        "페이·선불충전",
        "신용카드",
        "대출",
        "식비",
        "교통",
        "문화·여가",
    ]:
        assert by_name[group_name]["is_placeholder"] is True
    for leaf_name in ["현금", "급여", "외식", "식료품", "배달", "개시잔액"]:
        assert by_name[leaf_name]["is_placeholder"] is False

    assert by_name["외식"]["parent_id"] == by_name["식비"]["id"]
    assert by_name["식료품"]["parent_id"] == by_name["식비"]["id"]
    assert by_name["택시"]["parent_id"] == by_name["교통"]["id"]
    assert by_name["구독"]["parent_id"] == by_name["문화·여가"]["id"]

    again = client.post("/api/accounts/seed-standard").json()
    assert again["created"] == 0
    assert len(client.get("/api/accounts").json()) == 31


def test_seed_standard_accounts_recovers_from_partial_existing_tree(client):
    food = make_account(client, "식비", "expense")
    other = make_account(client, "다른그룹", "expense")
    make_child_account(client, "외식", "expense", other)  # 같은 이름, 다른 path

    res = client.post("/api/accounts/seed-standard")
    assert res.status_code == 200, res.text
    accounts = client.get("/api/accounts").json()
    food_rows = [a for a in accounts if a["name"] == "식비"]
    assert len(food_rows) == 1 and food_rows[0]["id"] == food
    food_children = {a["name"] for a in accounts if a["parent_id"] == food}
    assert {"외식", "식료품", "배달"} <= food_children


def test_account_rename_preserves_id_and_balances(client):
    toss = make_account(client, "Toss", "asset")
    salary = make_account(client, "월급", "income")
    opening = opening_account_id(client)
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "postings": [
                {"account_id": toss, "amount": 1000},
                {"account_id": opening, "amount": -1000},
            ],
        },
    )
    assert res.status_code == 201, res.text
    res = client.post(
        "/api/rules",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3000,
            "schedule": "monthly:25",
            "start_date": TODAY.isoformat(),
            "description": "월급",
        },
    )
    assert res.status_code == 201, res.text
    before = client.get("/api/balances").json()

    res = update_settings(client, toss, name=" 토스뱅크 ")
    assert res.status_code == 200, res.text
    renamed = res.json()["account"]
    assert renamed["id"] == toss
    assert renamed["name"] == "토스뱅크"

    after = client.get("/api/balances").json()
    assert after["net_worth"] == before["net_worth"]
    assert (
        next(b for b in after["accounts"] if b["account_id"] == toss)["balance"] == 1000
    )
    assert client.get("/api/status").json()["trial_balance_ok"] is True
    rule = client.get("/api/rules", params={"scenario_id": 1}).json()[0]
    assert rule["from_account_id"] == salary
    assert rule["to_account_id"] == toss


def test_account_rename_blocks_missing_system_empty_and_duplicate(client):
    opening = opening_account_id(client)
    missing = client.put(
        "/api/accounts/999/settings",
        json={"name": "없음", "parent_id": None, "is_overdraft": False, "version": 1},
    )
    assert missing.status_code == 404

    res = update_settings(client, opening, name="시작자본")
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "system_account_read_only"

    toss = make_account(client, "Toss", "asset")
    res = update_settings(client, toss, name="   ")
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "account_name_required"

    other = make_account(client, "Other", "asset")
    res = update_settings(client, other, name=" toss ")
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "account_name_conflict"


def test_account_create_and_rename_share_name_policy(client):
    make_account(client, "Toss", "asset")

    res = client.post("/api/accounts", json={"name": " toss ", "type": "asset"})
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "account_name_conflict"

    res = client.post("/api/accounts", json={"name": "   ", "type": "asset"})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "account_name_required"


def test_account_rename_duplicate_policy_includes_archived_and_allows_different_parent(
    client,
):
    archived = make_account(client, "Toss", "asset")
    assert client.post(f"/api/accounts/{archived}/archive").status_code == 200
    other = make_account(client, "Other", "asset")
    res = update_settings(client, other, name=" toss ")
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "account_name_conflict"
    assert res.json()["detail"]["conflicting_account_archived"] is True

    food = make_account(client, "식비", "expense")
    traffic = make_account(client, "교통", "expense")
    child = make_child_account(client, "기타", "expense", food)
    peer = make_child_account(client, "임시", "expense", traffic)
    res = update_settings(client, peer, name=" 기타 ")
    assert res.status_code == 200, res.text
    assert res.json()["account"]["name"] == "기타"
    assert res.json()["account"]["parent_id"] == traffic
    assert child != peer

    res = update_settings(client, archived, name="보관 Toss")
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "archived_account_read_only"


def test_ordinary_equity_opening_name_can_rename_when_not_system(client):
    parent = make_account(client, "자본그룹", "equity")
    ordinary = make_child_account(client, "개시잔액", "equity", parent)
    assert account_by_name(client, "자본그룹")["is_system"] is False

    res = update_settings(client, ordinary, name="내 자본")
    assert res.status_code == 200, res.text
    assert res.json()["account"]["name"] == "내 자본"
    assert res.json()["account"]["is_system"] is False


def test_account_settings_reparent_preserves_linked_accounting_data(client):
    source = make_account(client, "저축", "asset")
    target = client.post(
        "/api/accounts",
        json={"name": "입출금통장", "type": "asset", "is_placeholder": True},
    ).json()["id"]
    moving = make_child_account(client, "기업은행", "asset", source)
    income = make_account(client, "급여", "income")

    opening = client.post(
        f"/api/accounts/{moving}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 5_000_000, "state": "positive"},
    )
    assert opening.status_code == 201, opening.text
    rule = client.post(
        "/api/rules",
        json={
            "from_account_id": income,
            "to_account_id": moving,
            "amount": 3_000_000,
            "schedule": "monthly:25",
            "start_date": TODAY.isoformat(),
            "description": "월급",
        },
    )
    assert rule.status_code == 201, rule.text
    before_balance = next(
        row
        for row in client.get("/api/balances").json()["accounts"]
        if row["account_id"] == moving
    )
    before_opening = client.get("/api/opening-balances").json()
    before_rule = client.get("/api/rules").json()[0]

    moved = update_settings(
        client,
        moving,
        name="기업은행 급여통장",
        parent_id=target,
        is_overdraft=False,
    )
    assert moved.status_code == 200, moved.text
    payload = moved.json()
    assert payload["account"]["id"] == moving
    assert payload["account"]["parent_id"] == target
    assert payload["effects"] == {
        "moved": True,
        "previous_parent_id": source,
        "source_parent_grouped": True,
    }

    after_balance = next(
        row
        for row in client.get("/api/balances").json()["accounts"]
        if row["account_id"] == moving
    )
    assert after_balance["balance"] == before_balance["balance"]
    assert client.get("/api/opening-balances").json() == before_opening
    assert client.get("/api/rules").json()[0]["id"] == before_rule["id"]
    assert client.get("/api/rules").json()[0]["to_account_id"] == moving
    assert account_by_name(client, "저축")["is_placeholder"] is True
    assert client.get("/api/status").json()["trial_balance_ok"] is True


def test_account_settings_moves_account_to_top_level_with_null_parent(client):
    source = make_account(client, "저축 그룹", "asset")
    existing_root = make_account(client, "기존 최상위", "asset")
    moving = make_child_account(client, "옮길 계정", "asset", source)
    current = account_by_name(client, "옮길 계정")
    existing_root_position = next(
        account["position"]
        for account in client.get("/api/accounts").json()
        if account["id"] == existing_root
    )

    moved = client.put(
        f"/api/accounts/{moving}/settings",
        json={
            "name": current["name"],
            "parent_id": None,
            "is_overdraft": current["is_overdraft"],
            "version": current["version"],
        },
    )

    assert moved.status_code == 200, moved.text
    payload = moved.json()
    assert payload["account"]["id"] == moving
    assert payload["account"]["parent_id"] is None
    assert payload["account"]["position"] == existing_root_position + 1
    assert payload["effects"] == {
        "moved": True,
        "previous_parent_id": source,
        "source_parent_grouped": True,
    }
    assert account_by_name(client, "저축 그룹")["is_placeholder"] is True


def test_account_settings_combines_fields_and_rejects_stale_version(client):
    account_id = make_account(client, "현금", "asset")
    original = account_by_name(client, "현금")

    changed = update_settings(
        client,
        account_id,
        name="생활비 통장",
        is_overdraft=True,
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["account"]["version"] == original["version"] + 1

    stale = client.put(
        f"/api/accounts/{account_id}/settings",
        json={
            "name": "오래된 수정",
            "parent_id": None,
            "is_overdraft": False,
            "version": original["version"],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "account_settings_stale"
    assert stale.json()["detail"]["current_version"] == original["version"] + 1
    latest = account_by_name(client, "생활비 통장")
    assert latest["is_overdraft"] is True


def test_existing_opening_balance_account_migrates_to_system_flag():
    conn = connect(":memory:")
    conn.execute("""
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          parent_id INTEGER,
          currency TEXT NOT NULL DEFAULT 'KRW',
          archived INTEGER NOT NULL DEFAULT 0,
          is_placeholder INTEGER NOT NULL DEFAULT 0
        )
    """)
    parent = conn.execute(
        "INSERT INTO accounts (name, type) VALUES ('자본그룹', 'equity')"
    ).lastrowid
    ordinary = conn.execute(
        "INSERT INTO accounts (name, type, parent_id) VALUES ('개시잔액', 'equity', ?)",
        (parent,),
    ).lastrowid
    seeded = conn.execute(
        "INSERT INTO accounts (name, type) VALUES ('개시잔액', 'equity')"
    ).lastrowid

    conn.commit()
    init_db(conn)

    rows = conn.execute(
        "SELECT id, is_system FROM accounts WHERE name='개시잔액' AND type='equity'"
    ).fetchall()
    system_by_id = {row["id"]: row["is_system"] for row in rows}
    assert system_by_id[seeded] == 1
    assert system_by_id[ordinary] == 0


def test_materialize_idempotent_via_api(client):
    toss = make_account(client, "Toss", "asset")
    salary = make_account(client, "월급", "income")
    client.post(
        "/api/rules",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3_000_000,
            "schedule": f"monthly:{min(TODAY.day, 28)}",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    )
    first = client.post("/api/materialize").json()
    assert first["created"] >= 1
    second = client.post("/api/materialize").json()
    assert second["created"] == 0  # 같은 날 재호출 → 이중 기입 없음 (D9)


def test_delete_transaction(client):
    toss = make_account(client, "Toss", "asset")
    opening = opening_account_id(client)
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "postings": [
                {"account_id": toss, "amount": 1_000_000},
                {"account_id": opening, "amount": -1_000_000},
            ],
        },
    )
    txn_id = res.json()["id"]
    assert client.delete(f"/api/transactions/{txn_id}").status_code == 200
    assert client.get("/api/transactions").json() == []
    assert client.delete(f"/api/transactions/{txn_id}").status_code == 404


def test_update_rule_keeps_watermark(client):
    toss = make_account(client, "Toss", "asset")
    salary = make_account(client, "월급", "income")
    rule = client.post(
        "/api/rules",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3_000_000,
            "schedule": "monthly:1",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    ).json()
    client.post("/api/materialize")  # watermark 전진
    res = client.put(
        f"/api/rules/{rule['id']}",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3_500_000,
            "schedule": "monthly:1",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    )
    assert res.status_code == 200
    updated = res.json()
    assert updated["amount"]["amount"] == 3_500_000
    assert updated["last_materialized"] is not None  # 과거 불변 — watermark 유지
    # 수정 후 재실행해도 과거 재생성 없음
    assert client.post("/api/materialize").json()["created"] == 0


def test_account_archive_and_restore(client):
    toss = make_account(client, "Toss", "asset")
    # 보관
    res = client.post(f"/api/accounts/{toss}/archive")
    assert res.status_code == 200 and res.json()["archived"] is True
    # 목록에는 남는다 (거래 내역의 이름 해석용)
    accounts = client.get("/api/accounts").json()
    assert next(a for a in accounts if a["id"] == toss)["archived"] is True
    # 복원
    res = client.post(f"/api/accounts/{toss}/restore")
    assert res.json()["archived"] is False


def test_archive_blocked_by_children_and_rules(client):
    group = make_account(client, "식비그룹", "expense")
    child = client.post(
        "/api/accounts", json={"name": "배달", "type": "expense", "parent_id": group}
    ).json()["id"]
    # 자식이 있으면 차단
    assert client.post(f"/api/accounts/{group}/archive").status_code == 400
    # 자식 보관 후에는 가능
    assert client.post(f"/api/accounts/{child}/archive").status_code == 200
    assert client.post(f"/api/accounts/{group}/archive").status_code == 200
    # 부모가 보관 상태면 자식 복원 차단
    assert client.post(f"/api/accounts/{child}/restore").status_code == 400

    # 규칙 참조 차단
    toss = make_account(client, "Toss", "asset")
    salary = make_account(client, "월급", "income")
    rule = client.post(
        "/api/rules",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3_000_000,
            "schedule": "monthly:25",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    ).json()
    res = client.post(f"/api/accounts/{toss}/archive")
    assert res.status_code == 400 and "반복 규칙" in res.json()["detail"]["message"]
    # 규칙 삭제 후에는 보관 가능
    assert client.delete(f"/api/rules/{rule['id']}").status_code == 200
    assert client.post(f"/api/accounts/{toss}/archive").status_code == 200


def test_delete_rule_keeps_materialized_txns(client):
    toss = make_account(client, "Toss", "asset")
    salary = make_account(client, "월급", "income")
    rule = client.post(
        "/api/rules",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3_000_000,
            "schedule": f"monthly:{min(TODAY.day, 28)}",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    ).json()
    created = client.post("/api/materialize").json()["created"]
    assert created >= 1
    assert client.delete(f"/api/rules/{rule['id']}").status_code == 200
    txns = client.get("/api/transactions").json()
    assert len(txns) == created  # 거래는 보존 (D9)
    assert all(t["source_rule_id"] is None for t in txns)  # 출처 참조만 해제
    assert client.get("/api/rules").json() == []


def test_system_accounts_cannot_be_used_by_recurring_rules(client):
    cash = make_account(client, "현금", "asset")
    opening = opening_account_id(client)
    invalid = client.post(
        "/api/rules",
        json={
            "from_account_id": opening,
            "to_account_id": cash,
            "amount": 1000,
            "schedule": "monthly:1",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    )
    assert invalid.status_code == 400
    assert "시스템" in invalid.json()["detail"]["message"]

    income = make_account(client, "급여", "income")
    valid = client.post(
        "/api/rules",
        json={
            "from_account_id": income,
            "to_account_id": cash,
            "amount": 1000,
            "schedule": "monthly:1",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    ).json()
    update = client.put(
        f"/api/rules/{valid['id']}",
        json={
            "from_account_id": opening,
            "to_account_id": cash,
            "amount": 1000,
            "schedule": "monthly:1",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    )
    assert update.status_code == 400
    assert "시스템" in update.json()["detail"]["message"]


def test_legacy_system_rule_cannot_turn_materialized_txn_into_opening(client):
    cash = make_account(client, "현금", "asset")
    opening = opening_account_id(client)
    conn = connect(client.app.state.db_path)
    rule_id = conn.execute(
        "INSERT INTO recurring_rules "
        "(scenario_id, description, from_account_id, to_account_id, amount, schedule, start_date) "
        "VALUES (1, '잘못된 기존 규칙', ?, ?, 1000, ?, ?)",
        (
            opening,
            cash,
            f"monthly:{TODAY.day}",
            TODAY.replace(day=1).isoformat(),
        ),
    ).lastrowid
    conn.commit()
    conn.close()

    materialized = client.post("/api/materialize").json()
    assert materialized["created"] == 1
    assert client.get("/api/opening-balances").json() == []

    blocked = client.delete(f"/api/rules/{rule_id}")
    assert blocked.status_code == 409
    assert (
        blocked.json()["detail"]["code"] == "system_rule_has_materialized_transactions"
    )
    assert client.get("/api/opening-balances").json() == []

    txn_id = materialized["transactions"][0]["id"]
    assert client.delete(f"/api/transactions/{txn_id}").status_code == 200
    assert client.delete(f"/api/rules/{rule_id}").status_code == 200
    assert client.get("/api/opening-balances").json() == []


def test_placeholder_account_blocks_posting(client):
    # 그룹으로 계정 생성 → 직접 기장·규칙 대상 불가
    grp = client.post(
        "/api/accounts",
        json={"name": "입출금통장", "type": "asset", "is_placeholder": True},
    ).json()["id"]
    opening = opening_account_id(client)
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "postings": [
                {"account_id": grp, "amount": 1_000_000},
                {"account_id": opening, "amount": -1_000_000},
            ],
        },
    )
    assert res.status_code == 400 and "그룹" in res.json()["detail"]["message"]

    # 하위 리프를 만들면 거기엔 기장 가능
    leaf = client.post(
        "/api/accounts", json={"name": "토스뱅크", "type": "asset", "parent_id": grp}
    ).json()["id"]
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "postings": [
                {"account_id": leaf, "amount": 1_000_000},
                {"account_id": opening, "amount": -1_000_000},
            ],
        },
    )
    assert res.status_code == 201


def test_account_with_children_auto_nonpostable(client):
    # placeholder 아닌 일반 리프도 자식이 붙으면 자동으로 비기장
    parent = make_account(client, "식비", "expense")
    toss = make_account(client, "Toss", "asset")
    client.post(
        "/api/accounts", json={"name": "배달", "type": "expense", "parent_id": parent}
    )
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "postings": [
                {"account_id": parent, "amount": 5000},
                {"account_id": toss, "amount": -5000},
            ],
        },
    )
    assert res.status_code == 400 and "그룹" in res.json()["detail"]["message"]


def test_posted_leaf_can_gain_child_then_blocks_new_direct_postings(client):
    parent = make_account(client, "식비", "expense")
    cash = make_account(client, "현금", "asset")
    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "description": "기존 식비",
            "postings": [
                {"account_id": parent, "amount": 5000},
                {"account_id": cash, "amount": -5000},
            ],
        },
    )
    assert res.status_code == 201, res.text

    child = client.post(
        "/api/accounts",
        json={
            "name": "배달",
            "type": "expense",
            "parent_id": parent,
        },
    )
    assert child.status_code == 201, child.text

    res = client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "description": "새 식비",
            "postings": [
                {"account_id": parent, "amount": 7000},
                {"account_id": cash, "amount": -7000},
            ],
        },
    )
    assert res.status_code == 400 and "그룹" in res.json()["detail"]["message"]


def test_rule_reference_blocks_adding_child_until_rule_is_moved(client):
    parent = make_account(client, "식비", "expense")
    other_expense = make_account(client, "기타지출", "expense")
    cash = make_account(client, "현금", "asset")
    rule = client.post(
        "/api/rules",
        json={
            "from_account_id": cash,
            "to_account_id": parent,
            "amount": 30_000,
            "schedule": "monthly:25",
            "start_date": TODAY.replace(day=1).isoformat(),
            "description": "월 식비",
        },
    ).json()

    res = client.post(
        "/api/accounts",
        json={
            "name": "배달",
            "type": "expense",
            "parent_id": parent,
        },
    )
    assert res.status_code == 400
    assert "반복 규칙" in res.json()["detail"]["message"]

    res = client.put(
        f"/api/rules/{rule['id']}",
        json={
            "from_account_id": cash,
            "to_account_id": other_expense,
            "amount": 30_000,
            "schedule": "monthly:25",
            "start_date": TODAY.replace(day=1).isoformat(),
            "description": "월 식비",
        },
    )
    assert res.status_code == 200, res.text

    res = client.post(
        "/api/accounts",
        json={
            "name": "배달",
            "type": "expense",
            "parent_id": parent,
        },
    )
    assert res.status_code == 201, res.text


def test_clean_parent_can_gain_child(client):
    parent = make_account(client, "교통", "expense")
    child = client.post(
        "/api/accounts",
        json={
            "name": "택시",
            "type": "expense",
            "parent_id": parent,
        },
    )
    assert child.status_code == 201, child.text


def test_reclassify_direct_postings_to_child_preserves_combined_balance(client):
    parent = make_account(client, "식비", "expense")
    cash = make_account(client, "현금", "asset")
    amounts = [5000, 8000, 12_000]
    for i, amount in enumerate(amounts):
        res = client.post(
            "/api/transactions",
            json={
                "date": TODAY.isoformat(),
                "description": f"식비 {i}",
                "postings": [
                    {"account_id": parent, "amount": amount},
                    {"account_id": cash, "amount": -amount},
                ],
            },
        )
        assert res.status_code == 201, res.text
    child = make_child_account(client, "배달", "expense", parent)
    total = sum(amounts)

    before = client.get("/api/balances").json()["accounts"]
    before_sum = sum(b["balance"] for b in before if b["account_id"] in {parent, child})
    assert before_sum == total

    res = client.post(f"/api/accounts/{parent}/reclassify-direct", params={"to": child})
    assert res.status_code == 200, res.text
    assert res.json()["moved_postings"] == 3

    after = client.get("/api/balances").json()["accounts"]
    by_id = {b["account_id"]: b["balance"] for b in after}
    assert by_id[parent] == 0
    assert by_id[child] == total
    assert by_id[parent] + by_id[child] == before_sum
    assert client.get("/api/status").json()["trial_balance_ok"] is True


def test_reclassify_direct_rejects_non_child_or_group_target(client):
    parent = make_account(client, "식비", "expense")
    other = make_account(client, "기타지출", "expense")
    child_group = make_child_account(client, "외식", "expense", parent)
    make_child_account(client, "점심", "expense", child_group)

    res = client.post(f"/api/accounts/{parent}/reclassify-direct", params={"to": other})
    assert res.status_code == 400 and "직접 하위" in res.json()["detail"]["message"]

    res = client.post(
        f"/api/accounts/{parent}/reclassify-direct", params={"to": child_group}
    )
    assert res.status_code == 400 and "그룹" in res.json()["detail"]["message"]


def test_placeholder_toggle_guard(client):
    toss = make_account(client, "Toss", "asset")
    opening = opening_account_id(client)
    salary = make_account(client, "급여", "income")
    rule = client.post(
        "/api/rules",
        json={
            "from_account_id": salary,
            "to_account_id": toss,
            "amount": 3_000_000,
            "schedule": "monthly:25",
            "start_date": TODAY.replace(day=1).isoformat(),
        },
    ).json()
    # 반복 규칙이 계속 그룹을 직접 참조하게 되는 전환도 차단한다.
    blocked_by_rule = client.post(
        f"/api/accounts/{toss}/placeholder", json={"is_placeholder": True}
    )
    assert blocked_by_rule.status_code == 400
    assert "반복 규칙" in blocked_by_rule.json()["detail"]["message"]
    assert client.delete(f"/api/rules/{rule['id']}").status_code == 200
    # 그룹 전환 가능 (거래 없음)
    assert (
        client.post(
            f"/api/accounts/{toss}/placeholder", json={"is_placeholder": True}
        ).json()["is_placeholder"]
        is True
    )
    # 해제 후 거래 기록
    client.post(f"/api/accounts/{toss}/placeholder", json={"is_placeholder": False})
    client.post(
        "/api/transactions",
        json={
            "date": TODAY.isoformat(),
            "postings": [
                {"account_id": toss, "amount": 1000},
                {"account_id": opening, "amount": -1000},
            ],
        },
    )
    # 거래가 있으면 그룹 전환 차단
    res = client.post(
        f"/api/accounts/{toss}/placeholder", json={"is_placeholder": True}
    )
    assert res.status_code == 400 and "이미 거래" in res.json()["detail"]["message"]


def test_overdraft_account_api_contract_and_reversible_setting(client):
    ordinary = client.post(
        "/api/accounts",
        json={"name": "현금", "type": "asset"},
    )
    assert ordinary.status_code == 201
    assert ordinary.json()["is_overdraft"] is False

    invalid = client.post(
        "/api/accounts",
        json={"name": "대출", "type": "liability", "is_overdraft": True},
    )
    assert invalid.status_code == 409
    assert invalid.json()["detail"]["code"] == "overdraft_invalid_account"

    account_id = ordinary.json()["id"]
    enabled = update_settings(client, account_id, is_overdraft=True)
    assert enabled.status_code == 200
    assert enabled.json()["account"]["is_overdraft"] is True
    disabled = update_settings(client, account_id, is_overdraft=False)
    assert disabled.status_code == 200
    assert disabled.json()["account"]["is_overdraft"] is False

    missing = client.put(
        "/api/accounts/999/settings",
        json={"name": "없음", "parent_id": None, "is_overdraft": True, "version": 1},
    )
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "account_not_found"


def test_overdraft_hierarchy_and_archived_conflicts(client):
    parent = make_account(client, "입출금통장", "asset")
    make_child_account(client, "국민은행", "asset", parent)
    res = update_settings(client, parent, is_overdraft=True)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "overdraft_requires_leaf"

    overdraft = client.post(
        "/api/accounts",
        json={"name": "토스뱅크", "type": "asset", "is_overdraft": True},
    ).json()["id"]
    child = client.post(
        "/api/accounts",
        json={"name": "하위 계정", "type": "asset", "parent_id": overdraft},
    )
    assert child.status_code == 409
    assert child.json()["detail"]["code"] == "overdraft_parent_forbids_children"

    placeholder = client.post(
        f"/api/accounts/{overdraft}/placeholder",
        json={"is_placeholder": True},
    )
    assert placeholder.status_code == 409
    assert placeholder.json()["detail"]["code"] == "overdraft_cannot_be_group"

    archived = client.post(f"/api/accounts/{overdraft}/archive")
    assert archived.status_code == 200
    assert archived.json()["is_overdraft"] is True
    read_only = update_settings(client, overdraft, is_overdraft=False)
    assert read_only.status_code == 409
    assert read_only.json()["detail"]["code"] == "archived_account_read_only"
    restored = client.post(f"/api/accounts/{overdraft}/restore")
    assert restored.json()["is_overdraft"] is True


def test_negative_opening_balance_reports_liability_and_keeps_trial_balance(client):
    overdraft = client.post(
        "/api/accounts",
        json={"name": "케이뱅크", "type": "asset", "is_overdraft": True},
    ).json()["id"]
    before_net_worth = client.get("/api/balances").json()["net_worth"]

    created = client.post(
        f"/api/accounts/{overdraft}/opening-balance",
        json={"date": "2026-08-02", "amount": 74_566_154, "state": "negative"},
    )
    assert created.status_code == 201, created.text
    postings = [p["amount"]["amount"] for p in created.json()["postings"]]
    assert postings == [-74_566_154, 74_566_154]

    openings = client.get("/api/opening-balances").json()
    assert openings == [
        {
            "account_id": overdraft,
            "transaction_id": created.json()["id"],
            "date": "2026-08-02",
            "state": "negative",
        }
    ]
    balance = client.get("/api/balances", params={"at": "2026-08-02"}).json()
    row = next(b for b in balance["accounts"] if b["account_id"] == overdraft)
    assert row["type"] == "asset"
    assert row["reporting_type"] == "liability"
    assert row["balance"] == -74_566_154
    assert balance["net_worth"] == before_net_worth - 74_566_154
    assert client.get("/api/status").json()["trial_balance_ok"] is True


def test_overdraft_reporting_type_returns_to_asset_at_zero(client):
    overdraft = client.post(
        "/api/accounts",
        json={"name": "우리은행", "type": "asset", "is_overdraft": True},
    ).json()["id"]
    income = make_account(client, "상환 재원", "income")
    client.post(
        f"/api/accounts/{overdraft}/opening-balance",
        json={"date": "2026-08-02", "amount": 1000, "state": "negative"},
    )
    client.post(
        "/api/transactions",
        json={
            "date": "2026-08-03",
            "postings": [
                {"account_id": overdraft, "amount": 1000},
                {"account_id": income, "amount": -1000},
            ],
        },
    )

    negative = client.get("/api/balances", params={"at": "2026-08-02"}).json()
    at_zero = client.get("/api/balances", params={"at": "2026-08-03"}).json()
    negative_row = next(b for b in negative["accounts"] if b["account_id"] == overdraft)
    zero_row = next(b for b in at_zero["accounts"] if b["account_id"] == overdraft)
    assert negative_row["reporting_type"] == "liability"
    assert zero_row["balance"] == 0
    assert zero_row["reporting_type"] == "asset"


def test_opening_balance_duplicate_delete_and_validation(client):
    cash = make_account(client, "현금", "asset")
    created = client.post(
        f"/api/accounts/{cash}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 1000, "state": "positive"},
    )
    assert created.status_code == 201

    duplicate = client.post(
        f"/api/accounts/{cash}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 2000, "state": "positive"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "opening_already_recorded"

    assert client.delete(f"/api/transactions/{created.json()['id']}").status_code == 200
    retry = client.post(
        f"/api/accounts/{cash}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 2000, "state": "positive"},
    )
    assert retry.status_code == 201

    negative = client.post(
        f"/api/accounts/{make_account(client, '예금', 'asset')}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 1, "state": "negative"},
    )
    assert negative.status_code == 400
    assert negative.json()["detail"]["code"] == "negative_opening_requires_overdraft"


def test_opening_balance_rejects_missing_group_and_system_accounts(client):
    missing = client.post(
        "/api/accounts/999/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 1, "state": "positive"},
    )
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "account_not_found"

    group = client.post(
        "/api/accounts",
        json={"name": "입출금통장", "type": "asset", "is_placeholder": True},
    ).json()["id"]
    invalid_group = client.post(
        f"/api/accounts/{group}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 1, "state": "positive"},
    )
    assert invalid_group.status_code == 400
    assert invalid_group.json()["detail"]["code"] == "opening_invalid_account"

    opening = opening_account_id(client)
    invalid_system = client.post(
        f"/api/accounts/{opening}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 1, "state": "positive"},
    )
    assert invalid_system.status_code == 400
    assert invalid_system.json()["detail"]["code"] == "opening_invalid_account"


def test_opening_balance_requires_seeded_system_equity(client):
    cash = make_account(client, "현금", "asset")
    conn = connect(client.app.state.db_path)
    conn.execute("DELETE FROM accounts WHERE is_system=1 AND type='equity'")
    conn.commit()
    conn.close()

    res = client.post(
        f"/api/accounts/{cash}/opening-balance",
        json={"date": TODAY.isoformat(), "amount": 1, "state": "positive"},
    )
    assert res.status_code == 404
    assert res.json()["detail"]["code"] == "opening_account_not_found"


def test_scenario_balance_uses_raw_balance_for_overdraft_reporting(client):
    overdraft = client.post(
        "/api/accounts",
        json={"name": "마이너스통장", "type": "asset", "is_overdraft": True},
    ).json()["id"]
    client.post(
        f"/api/accounts/{overdraft}/opening-balance",
        json={"date": "2026-08-01", "amount": 1000, "state": "negative"},
    )
    scenario = client.post(
        "/api/scenarios",
        json={"name": "가설", "fork_date": "2026-08-02"},
    ).json()

    result = client.get(
        "/api/balances",
        params={"scenario_id": scenario["scenario"]["id"], "at": "2026-08-02"},
    ).json()
    row = next(item for item in result["accounts"] if item["account_id"] == overdraft)
    assert row["balance"] == -1000
    assert row["reporting_type"] == "liability"
