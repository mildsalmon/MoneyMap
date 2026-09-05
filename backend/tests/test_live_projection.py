"""Hand-calculated golden case: no calculator is copied into these assertions."""

import datetime as dt
from dataclasses import replace

import pytest
from hypothesis import given, strategies as st

from moneymap.domain.projection import (
    ProjectionInputs,
    ProjectionEvent,
    fold_projection,
    expand_events,
)
from moneymap.domain.scenario import Scenario
from moneymap.adapters.sqlite.projection import ProjectionInputReader
from moneymap.adapters.sqlite import connect
from test_scenario_lifecycle import create, account
import test_scenario_lifecycle as lifecycle

client = lifecycle.client

FORK = dt.date(2026, 1, 31)


def post(client, sid, date, postings, description=""):
    if sid == 1:
        result = client.post(
            "/api/transactions",
            json={
                "date": date,
                "postings": [
                    {"account_id": a, "amount": amount} for a, amount in postings
                ],
                "description": description,
            },
        )
        assert result.status_code == 201, result.text
    else:
        conn = connect(client.app.state.db_path)
        with conn:
            tid = conn.execute(
                "INSERT INTO transactions(scenario_id,date,description) VALUES(?,?,?)",
                (sid, date, description),
            ).lastrowid
            conn.executemany(
                "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
                [(tid, *p) for p in postings],
            )
            conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (tid,))
        conn.close()


@pytest.fixture
def golden(client):
    bank = account(client, "bank", "asset")
    savings = account(client, "savings", "asset")
    income = account(client, "income", "income")
    expense = account(client, "expense", "expense")
    equity = next(a["id"] for a in client.get("/api/accounts").json() if a["is_system"])
    post(client, 1, "2026-01-31", [(bank, 10_000), (equity, -10_000)])
    post(client, 1, "2026-02-01", [(bank, 99_999), (income, -99_999)])
    scenario = create(client)
    sid = scenario["id"]

    def rule(source, target, amount, owner, version=1, start="2026-01-01", end=None):
        body = {
            "from_account_id": source,
            "to_account_id": target,
            "amount": amount,
            "schedule": "monthly:31",
            "start_date": start,
            "end_date": end,
        }
        result = client.post(
            "/api/rules" if owner == 1 else f"/api/scenarios/{owner}/rules",
            json=body if owner == 1 else {**body, "scenario_version": version},
        )
        assert result.status_code == 201, result.text
        return result.json()

    salary = rule(income, bank, 1000, 1)
    rule(bank, expense, 300, 1)
    rule(income, bank, 200, sid)
    rule(bank, savings, 500, sid, version=2)
    rule(income, bank, 777, sid, version=3, end="2026-01-31")  # ended: zero occurrences
    post(client, sid, "2026-02-10", [(bank, -50), (expense, 50)])
    post(
        client, sid, "2028-01-01", [(bank, -999), (expense, 999)]
    )  # preserved outside horizon
    return client, sid, bank, income, salary


@pytest.mark.parametrize(
    "months,end,baseline,scenario",
    [
        (3, "2026-04-30", 12100, 12650),
        (6, "2026-07-31", 14200, 15350),
        (12, "2027-01-31", 18400, 20750),
    ],
)
def test_hand_calculated_golden(golden, months, end, baseline, scenario):
    client, sid, *_ = golden
    response = client.get(f"/api/projection?scenario_id={sid}&months={months}")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["projection_start"] == "2026-02-01" and data["projection_end"] == end
    assert data["net_worth"]["baseline"]["points"][0] == {
        "date": "2026-01-31",
        "balance": 10000,
    }
    assert data["net_worth"]["baseline"]["points"][-1]["balance"] == baseline
    assert data["net_worth"]["scenario"]["points"][-1]["balance"] == scenario
    assert data["monthly_income_expense"][0] == {
        "month": "2026-02",
        "baseline": {"income": 1000, "expense": 300},
        "scenario": {"income": 1200, "expense": 350},
    }
    assert data["capabilities"] == {"scenario_liquidity": False}
    assert "cash" not in data and "cash_config_revision" not in data["basis"]
    for curve in data["net_worth"].values():
        dates = [p["date"] for p in curve["points"]]
        assert dates == sorted(set(dates)) and len(dates) <= 367


def test_actual_changes_live_for_active_and_archived(golden):
    client, sid, bank, income, salary = golden
    path = f"/api/projection?scenario_id={sid}&months=3"
    before = client.get(path).json()
    client.post(f"/api/scenarios/{sid}/archive", json={"version": 4})
    body = {
        "from_account_id": income,
        "to_account_id": bank,
        "amount": 2000,
        "schedule": "monthly:31",
        "start_date": "2026-01-01",
    }
    assert client.put(f"/api/rules/{salary['id']}", json=body).status_code == 200
    after = client.get(path).json()
    assert after["net_worth"]["baseline"]["points"][-1]["balance"] == 15100
    assert after["net_worth"]["scenario"]["points"][-1]["balance"] == 15650
    assert (
        after["basis"]["actual_rule_revision"] > before["basis"]["actual_rule_revision"]
    )
    post(client, 1, "2026-01-31", [(bank, 500), (income, -500)])
    corrected = client.get(path).json()
    assert corrected["net_worth"]["baseline"]["points"][0]["balance"] == 10500
    assert (
        corrected["basis"]["actual_ledger_revision"]
        > after["basis"]["actual_ledger_revision"]
    )
    post(client, 1, "2026-02-01", [(bank, 9000), (income, -9000)])
    assert client.get(path).json()["net_worth"] == corrected["net_worth"]


def test_query_contract_and_sql_budget(golden):
    client, sid, *_ = golden
    for query in (
        "",
        f"scenario_id={sid}&months=5",
        f"scenario_id={sid}&months=0",
        "scenario_id=-1",
    ):
        assert client.get("/api/projection?" + query).status_code == 422
    conn = connect(client.app.state.db_path)
    sql = []
    conn.set_trace_callback(sql.append)
    conn.execute("BEGIN")
    inputs = ProjectionInputReader(conn).read(sid)
    fold_projection(inputs, 12)
    conn.rollback()
    assert len(sql) <= 15, sql
    assert len(inputs.planned) == 2
    conn.close()


@given(
    amount=st.integers(min_value=1, max_value=10**9),
    refund=st.integers(min_value=1, max_value=10**6),
)
def test_transfer_neutrality_and_signed_monthly_fold(amount, refund):
    scenario = Scenario(id=2, name="property", base_scenario_id=1, fork_date=FORK)
    events = (
        ProjectionEvent(
            dt.date(2026, 2, 1),
            "planned_transaction",
            1,
            "transfer",
            "scenario",
            ((2, -amount), (3, amount)),
        ),
        ProjectionEvent(
            dt.date(2026, 2, 1),
            "planned_transaction",
            2,
            "refund",
            "scenario",
            ((2, refund), (4, -refund)),
        ),
    )
    inputs = ProjectionInputs(
        scenario,
        1,
        1,
        ((2, "asset"), (3, "asset"), (4, "expense")),
        ((2, 1000),),
        (),
        (),
        events,
    )
    result = fold_projection(inputs, 3)
    assert all(
        sum(amount for _, amount in e.postings) == 0
        for e in expand_events(inputs, dt.date(2026, 2, 1), dt.date(2026, 4, 30))
    )
    assert result["net_worth"]["scenario"]["points"][-1]["balance"] == 1000 + refund
    assert result["monthly_income_expense"][0]["scenario"] == {
        "income": 0,
        "expense": -refund,
    }
    empty = fold_projection(replace(inputs, planned=()), 3)
    assert empty["net_worth"]["baseline"] == empty["net_worth"]["scenario"]


def test_snapshot_models_cannot_be_mutated(golden):
    from pydantic import ValidationError

    client, sid, *_ = golden
    conn = connect(client.app.state.db_path)
    conn.execute("BEGIN")
    try:
        inputs = ProjectionInputReader(conn).read(sid)
        with pytest.raises(ValidationError, match="frozen"):
            inputs.scenario.name = "changed"
        with pytest.raises(ValidationError, match="frozen"):
            inputs.actual_rules[0].description = "changed"
    finally:
        conn.rollback()
        conn.close()


def test_projection_rejects_repeated_scenario_id(client):
    assert client.get("/api/projection?scenario_id=1&scenario_id=2").status_code == 422


def test_unconverted_dashboard_preserves_snapshot_rules(golden, monkeypatch):
    from moneymap.app_services import projection

    client, sid, bank, income, salary = golden
    monkeypatch.setattr(
        projection, "now", lambda: dt.datetime(2026, 2, 1, tzinfo=dt.timezone.utc)
    )
    conn = connect(client.app.state.db_path)
    with conn:
        conn.execute(
            "UPDATE scenarios SET rule_mode='legacy_snapshot' WHERE id=?", (sid,)
        )
    conn.close()
    assert client.get(f"/api/projection?scenario_id={sid}").status_code == 409
    path = f"/api/dashboard-projection?scenario_ids={sid}&months=3"
    curve = next(s for s in client.get(path).json()["series"] if s["id"] == sid)
    # Old snapshot boundary includes the fork-day rule: 4*200 + 777 - 50.
    assert curve["points"][-1]["net_worth"] == 11_527
    body = {
        "from_account_id": income,
        "to_account_id": bank,
        "amount": 9000,
        "schedule": "monthly:31",
        "start_date": "2026-01-01",
    }
    assert client.put(f"/api/rules/{salary['id']}", json=body).status_code == 200
    assert next(s for s in client.get(path).json()["series"] if s["id"] == sid) == curve


@pytest.mark.parametrize("selected_count", [1, 3])
def test_legacy_dashboard_batches_transactions_and_shares_actual_basis(
    client, monkeypatch, selected_count
):
    from moneymap.app_services import projection
    from moneymap.app_services.projection import build_dashboard_projection
    from moneymap.adapters.sqlite.scenarios import ScenarioWriter
    from moneymap.domain import simulation

    monkeypatch.setattr(
        projection, "now", lambda: dt.datetime(2026, 2, 1, tzinfo=dt.timezone.utc)
    )
    bank = account(client, "legacy cash", "asset")
    expense = account(client, "legacy expense", "expense")
    sids = [create(client, f"legacy {index}")["id"] for index in range(selected_count)]
    conn = connect(client.app.state.db_path)
    original = simulation.variable_monthly_spend
    folds = []

    def count_fold(*args, **kwargs):
        folds.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(simulation, "variable_monthly_spend", count_fold)
    try:
        with conn:
            for sid in sids:
                conn.execute(
                    "UPDATE scenarios SET rule_mode='legacy_snapshot' WHERE id=?",
                    (sid,),
                )
        sql_counts = []
        for added, total in ((1, 1), (100, 101)):
            with conn:
                for sid in [1, *sids]:
                    for _ in range(added):
                        tid = conn.execute(
                            "INSERT INTO transactions(scenario_id,date) VALUES(?,?)",
                            (sid, "2026-01-31" if sid == 1 else "2026-02-01"),
                        ).lastrowid
                        conn.executemany(
                            "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
                            [(tid, bank, -100), (tid, expense, 100)],
                        )
                        conn.execute(
                            "UPDATE transactions SET posted=1 WHERE id=?", (tid,)
                        )
            statements = []
            folds.clear()
            conn.set_trace_callback(statements.append)
            conn.execute("BEGIN")
            try:
                result = build_dashboard_projection(
                    ProjectionInputReader(conn), ScenarioWriter(conn), sids, 3
                )
            finally:
                conn.rollback()
                conn.set_trace_callback(None)
            assert len(folds) == 1  # Shared actual-ledger averaging per request.
            sql_counts.append(len(statements))
            assert len(statements) <= 30, statements
            curves = [
                series["points"]
                for series in result["series"]
                if series["kind"] == "scenario"
            ]
            assert len(curves) == selected_count
            assert all(curve == curves[0] for curve in curves)
            # Per pair: -100 opening, -100 owned, -100 on each Jan–Apr month end.
            assert curves[0][-1]["net_worth"] == -600 * total
        # Both actual and owned transaction volumes grew 101-fold.
        assert sql_counts[0] == sql_counts[1]
    finally:
        conn.close()
