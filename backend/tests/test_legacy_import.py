import csv
import json

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, init_db
from moneymap.api import create_app
from moneymap.legacy_import import import_legacy_csv
from moneymap.legacy_import import parse_legacy_csv, source_hash


def test_private_corrections_are_source_scoped_and_preserve_raw_memo(tmp_path):
    source, _ = _write_fixture(tmp_path)
    local = tmp_path / "corrections.json"
    local.write_text(json.dumps({source_hash(source): {"2": ["강남점", "합성 교정점"]}}), encoding="utf-8")
    rows, _ = parse_legacy_csv(source, expected_hash=None, corrections_path=local)
    assert rows[0].memo == "합성 교정점\n멘토링"
    assert rows[0].raw_memo == "강남점"
    local.write_text(json.dumps({"different-source": {"2": ["강남점", "잘못된 교정"]}}), encoding="utf-8")
    assert parse_legacy_csv(source, expected_hash=None, corrections_path=local)[0][0].memo == "강남점\n멘토링"
    assert parse_legacy_csv(source, expected_hash=None, corrections_path=tmp_path / "absent.json")[0][0].memo == "강남점\n멘토링"


@pytest.mark.parametrize("correction", ["invalid", ["one"], ["", "new"], [1, "new"]])
def test_private_corrections_reject_invalid_pairs(tmp_path, correction):
    source, _ = _write_fixture(tmp_path)
    local = tmp_path / "corrections.json"
    local.write_text(json.dumps({source_hash(source): {"2": correction}}), encoding="utf-8")
    with pytest.raises(ValueError, match="교정 형식"):
        parse_legacy_csv(source, expected_hash=None, corrections_path=local)


@pytest.fixture
def client():
    with TestClient(create_app(":memory:")) as test_client:
        yield test_client


def _write_fixture(tmp_path):
    source = tmp_path / "legacy.csv"
    with source.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["날짜", "내역", "금액", "누계", "왼쪽유형", "왼쪽계정", "오른쪽유형", "오른쪽계정", "메모"])
        writer.writerow(["2026-08-01", "점심", "10000", "10000", "비용", "식비", "자산", "현금", "강남점"])
        writer.writerow(["멘토링"])
        writer.writerow(["2026-08-02", "월급", "100000", "110000", "자산", "테스트은행", "수익", "월급", ""])
    classifications = tmp_path / "classifications"
    classifications.mkdir()
    with (classifications / "csv-expense-default-classification-review-20260906.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["원본 행", "연결 계정", "태그"])
        writer.writerow(["2", "식비/외식", "데이트"])
    return source, classifications


def test_import_is_lossless_atomic_and_idempotent(tmp_path):
    source, classifications = _write_fixture(tmp_path)
    conn = connect(":memory:")
    init_db(conn)

    dry = import_legacy_csv(conn, source, classifications, apply=False, expected_hash=None)
    assert dry["parsed_transactions"] == 2
    assert dry["orphan_memo_rows"] == [3]
    assert dry["postings"] == 4
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0

    applied = import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
    assert applied["inserted"] == 2
    assert applied["provenance_rows"] == 2
    assert applied["imbalanced"] == 0
    assert conn.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 4
    first = conn.execute("SELECT id,memo FROM transactions ORDER BY id LIMIT 1").fetchone()
    assert first["memo"] == "강남점\n멘토링"
    assert conn.execute(
        "SELECT g.name FROM tags g JOIN transaction_tags tt ON tt.tag_id=g.id WHERE tt.txn_id=?",
        (first["id"],),
    ).fetchone()[0] == "데이트"

    repeated = import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
    assert repeated["inserted"] == 0
    assert repeated["skipped_existing"] == 2
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 2


def test_import_restores_reviewed_asset_and_personal_debt_hierarchy(tmp_path):
    source = tmp_path / "legacy.csv"
    with source.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["날짜", "내역", "금액", "누계", "왼쪽유형", "왼쪽계정", "오른쪽유형", "오른쪽계정", "메모"])
        writer.writerow(["2026-08-01", "이동", "10000", "10000", "자산", "ok저축은행", "자산", "현금", ""])
        writer.writerow(["2026-08-02", "아파트 취득", "20000", "30000", "자산", "아파트", "자산", "현금", ""])
        writer.writerow(["2026-08-03", "차용", "30000", "60000", "부채", "갚을돈", "자산", "현금", ""])
        writer.writerow(["2026-08-04", "USD 사기", "40000", "100000", "비용", "원화에서달러로환전", "자산", "현금", ""])
    classifications = tmp_path / "classifications"
    classifications.mkdir()
    with (classifications / "csv-expense-default-classification-review-20260906.csv").open(
        "w", encoding="utf-8", newline=""
    ) as stream:
        csv.writer(stream).writerow(["원본 행", "연결 계정"])

    conn = connect(":memory:")
    init_db(conn)
    import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)

    rows = conn.execute(
        "WITH RECURSIVE tree(id,name,parent_id,path) AS ("
        "SELECT id,name,parent_id,name FROM accounts WHERE parent_id IS NULL "
        "UNION ALL SELECT a.id,a.name,a.parent_id,tree.path || ' > ' || a.name "
        "FROM accounts a JOIN tree ON a.parent_id=tree.id) "
        "SELECT name,path FROM tree WHERE name IN "
        "('OK저축은행','한마을아파트','갚을돈','원화에서달러로환전')"
    ).fetchall()
    assert {row["name"]: row["path"] for row in rows} == {
        "OK저축은행": "입출금통장 > OK저축은행",
        "한마을아파트": "한마을아파트",
        "갚을돈": "개인채무 > 갚을돈",
        "원화에서달러로환전": "원화에서달러로환전",
    }
    assert conn.execute("SELECT is_placeholder FROM accounts WHERE name='개인채무'").fetchone()[0] == 1


def test_tag_round_trip_and_tag_catalog(client):
    food = client.post("/api/accounts", json={"name": "식사", "type": "expense"}).json()["id"]
    cash = client.post("/api/accounts", json={"name": "지갑", "type": "asset"}).json()["id"]
    response = client.post(
        "/api/transactions",
        json={
            "date": "2026-09-06",
            "description": "저녁",
            "memo": "기념일",
            "tags": ["데이트", "여행", "데이트"],
            "postings": [
                {"account_id": food, "amount": 50000},
                {"account_id": cash, "amount": -50000},
            ],
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["tags"] == ["데이트", "여행"]
    assert client.get("/api/transactions").json()[0]["tags"] == ["데이트", "여행"]
    assert client.get("/api/tags").json() == ["데이트", "여행"]
