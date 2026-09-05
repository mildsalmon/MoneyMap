"""PR1 contracts for existing endpoints. Lifecycle/version guards arrive in PR2."""

import pytest
from fastapi.testclient import TestClient

from moneymap.api import create_app
from moneymap.domain.errors import DomainConflictError


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(str(tmp_path / "ledger.db"))) as client:
        yield client


@pytest.mark.parametrize(
    "method,url,body,status,code,context",
    [
        ("post", "/api/accounts/999/archive", None, 404, "account_not_found", {}),
        (
            "post",
            "/api/accounts/999/placeholder",
            {"is_placeholder": True},
            404,
            "account_not_found",
            {},
        ),
        ("delete", "/api/rules/999", None, 404, "rule_not_found", {}),
        (
            "get",
            "/api/projection?scenario_ids=invalid",
            None,
            400,
            "invalid_scenario_ids",
            {},
        ),
        (
            "post",
            "/api/transactions",
            {
                "date": "2026-09-01",
                "postings": [
                    {"account_id": 998, "amount": 1},
                    {"account_id": 999, "amount": -1},
                ],
            },
            404,
            "account_not_found",
            {"account_id": 998},
        ),
    ],
)
def test_status_code_and_full_context(client, method, url, body, status, code, context):
    response = client.request(method, url, json=body)
    assert response.status_code == status
    detail = response.json()["detail"]
    assert detail["code"] == code
    assert isinstance(detail["message"], str) and detail["message"]
    assert {k: v for k, v in detail.items() if k not in {"code", "message"}} == context


def test_request_validation_remains_fastapi_native_and_precedes_target_lookup(client):
    response = client.post(
        "/api/accounts/999/opening-balance",
        json={"date": "invalid", "amount": 1, "state": "positive"},
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert isinstance(detail, list)
    assert detail[0]["loc"] == ["body", "date"]
    assert "type" in detail[0] and "msg" in detail[0]
    # Dependency is cleaned up after validation failure; next write succeeds.
    assert (
        client.post("/api/accounts", json={"name": "cash", "type": "asset"}).status_code
        == 201
    )


def test_existence_precedes_account_command_rules(client):
    group = client.post(
        "/api/accounts", json={"name": "group", "type": "asset", "is_placeholder": True}
    ).json()["id"]
    response = client.post(
        "/api/transactions",
        json={
            "date": "2026-09-01",
            "postings": [
                {"account_id": group, "amount": 1},
                {"account_id": 999, "amount": -1},
            ],
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "account_not_found"


def test_nested_context_is_lossless(client):
    @client.app.get("/contract-error")
    def failure():
        raise DomainConflictError(
            "conflict",
            code="test_conflict",
            context={
                "conflicts": [{"id": 7, "dates": ["2026-09-01"]}],
                "retryable": False,
                "current_version": 4,
            },
        )

    response = client.get("/contract-error")
    assert response.status_code == 409
    assert response.json() == {
        "detail": {
            "code": "test_conflict",
            "message": "conflict",
            "conflicts": [{"id": 7, "dates": ["2026-09-01"]}],
            "retryable": False,
            "current_version": 4,
        }
    }


def test_empty_scenario_name_is_native_422(client):
    response = client.post(
        "/api/scenarios", json={"name": "", "fork_date": "2026-09-01"}
    )
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "name"]
    assert client.get("/api/scenarios").json() == []


def test_model_validation_error_uses_envelope(client):
    response = client.post("/api/accounts", json={"name": "", "type": "asset"})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "validation_error"
    assert response.json()["detail"]["errors"][0]["loc"] == ["name"]


def test_unknown_scenario_balance_has_stable_error(client):
    response = client.get("/api/balances?scenario_id=999")
    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "scenario_not_found",
        "message": "시나리오가 없습니다",
        "scenario_id": 999,
    }


def test_http_errors_keep_headers(client):
    missing = client.get("/api/no-such-route")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "not_found"
    response = client.put("/api/health")
    assert response.status_code == 405
    assert response.json()["detail"]["code"] == "method_not_allowed"
    assert "GET" in response.headers["allow"]


@pytest.mark.parametrize(
    "kind,status,code,message",
    [
        (
            "OperationalError",
            500,
            "database_error",
            "데이터베이스 작업을 완료하지 못했습니다",
        ),
        (
            "IntegrityError",
            400,
            "database_constraint",
            "저장 데이터의 제약 조건을 확인하세요",
        ),
    ],
)
def test_generic_database_errors_do_not_expose_sql(client, kind, status, code, message):
    import sqlite3

    @client.app.get("/database-failure")
    def failure():
        raise getattr(sqlite3, kind)("private SQL and ledger content")

    response = client.get("/database-failure")
    assert response.status_code == status
    assert response.json() == {"detail": {"code": code, "message": message}}
    assert "private" not in response.text
