import datetime
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from moneymap import app_services, dependencies
from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite.rules import (
    ScenarioRuleWriter,
    SqliteRecurringRuleRepository,
)
from moneymap.adapters.sqlite.uow import SqliteUnitOfWork
from moneymap.api import create_app
from moneymap.domain import (
    Money,
    Posting,
    RecurringRule,
    Scenario,
    Schedule,
    Transaction,
)
from moneymap.domain.errors import DomainInvariantError

DAY = datetime.date(2026, 9, 1)


@pytest.fixture
def ledger(tmp_path):
    conn = connect(str(tmp_path / "ledger.db"))
    init_db(conn)
    conn.execute(
        "INSERT INTO accounts(id,name,type,position) VALUES(2,'현금','asset',1),(3,'월급','income',1)"
    )
    conn.commit()
    yield conn
    conn.close()


def snapshot(conn):
    return {
        table: [tuple(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY id")]
        for table in (
            "accounts",
            "scenarios",
            "recurring_rules",
            "transactions",
            "postings",
        )
    }


def rule(sid=1):
    return RecurringRule(
        scenario_id=sid,
        from_account_id=3,
        to_account_id=2,
        amount=Money(amount=100),
        schedule=Schedule(spec="monthly:1"),
        start_date=DAY,
    )


@pytest.mark.parametrize(
    "stage", ["scenario", "rule", "transaction", "posting", "post"]
)
def test_aggregate_failure_rolls_back_all_children(ledger, stage):
    # Add unrelated data first, then inject failure at each successive storage phase.
    with SqliteUnitOfWork(ledger) as uow:
        uow.rules.save(rule())
        uow.scenarios.save(
            Scenario(name="unrelated", base_scenario_id=1, fork_date=DAY)
        )
    before = snapshot(ledger)
    trigger = {
        "scenario": "BEFORE INSERT ON scenarios",
        "rule": "BEFORE INSERT ON recurring_rules",
        "transaction": "BEFORE INSERT ON transactions",
        "posting": "BEFORE INSERT ON postings WHEN NEW.amount < 0",
        "post": "BEFORE UPDATE OF posted ON transactions WHEN NEW.posted=1",
    }[stage]
    ledger.execute(
        f"CREATE TEMP TRIGGER fail_step {trigger} BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="injected"):
        with SqliteUnitOfWork(ledger) as uow:
            scenario = uow.scenarios.save(
                Scenario(name="new", base_scenario_id=1, fork_date=DAY)
            )
            saved_rule = uow.rules.save(rule(scenario.id))
            uow.transactions.save(
                Transaction(
                    scenario_id=scenario.id,
                    date=DAY,
                    source_rule_id=saved_rule.id,
                    postings=[
                        Posting(account_id=2, amount=Money(amount=100)),
                        Posting(account_id=3, amount=Money(amount=-100)),
                    ],
                )
            )
    assert snapshot(ledger) == before
    assert not ledger.in_transaction


def test_create_does_not_copy_rules_and_commits_once(ledger, monkeypatch):
    from moneymap.app_services.scenarios import create_scenario
    from moneymap.adapters.sqlite.scenarios import ScenarioWriter

    with SqliteUnitOfWork(ledger) as uow:
        uow.rules.save(rule())
    before = snapshot(ledger)
    original = ScenarioWriter.save

    def fail_after_insert(self, scenario):
        original(self, scenario)
        raise DomainInvariantError("injected")

    monkeypatch.setattr(ScenarioWriter, "save", fail_after_insert)
    with pytest.raises(DomainInvariantError):
        create_scenario("new", "", DAY, SqliteUnitOfWork(ledger))
    assert snapshot(ledger) == before
    monkeypatch.setattr(ScenarioWriter, "save", original)
    statements = []
    ledger.set_trace_callback(statements.append)
    result = create_scenario("new", "", DAY, SqliteUnitOfWork(ledger))
    assert result["effective_actual_rules"] == 1
    assert not SqliteUnitOfWork(ledger).rules.find_by_scenario(result["scenario"].id)
    assert statements.count("COMMIT") == statements.count("BEGIN IMMEDIATE") == 1
    with pytest.raises(RuntimeError, match="UnitOfWork"):
        SqliteUnitOfWork(ledger).rules.save(rule())


def test_projection_read_snapshot_and_independent_requests(tmp_path, monkeypatch):
    with TestClient(create_app(str(tmp_path / "api.db"))) as client:
        account = client.post(
            "/api/accounts", json={"name": "현금", "type": "asset"}
        ).json()["id"]
        expected_before = client.get("/api/projection?scenario_id=1").json()
        expected_before.pop("as_of")
        entered, written = Barrier(2), Barrier(2)
        from moneymap.adapters.sqlite.projection import ProjectionInputReader

        original = ProjectionInputReader.read

        def paused(self, sid):
            self.conn.execute("SELECT * FROM calculation_revisions").fetchall()
            entered.wait(timeout=5)
            written.wait(timeout=5)
            return original(self, sid)

        monkeypatch.setattr(ProjectionInputReader, "read", paused)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(client.get, "/api/projection?scenario_id=1")
            entered.wait(timeout=5)
            assert client.get("/api/health").status_code == 200
            created = client.post(
                f"/api/accounts/{account}/opening-balance",
                json={
                    "date": datetime.date.today().isoformat(),
                    "amount": 1000,
                    "state": "positive",
                },
            )
            assert created.status_code == 201
            written.wait(timeout=5)
            result = pending.result(timeout=5).json()
            result.pop("as_of")
            assert result == expected_before
        monkeypatch.setattr(ProjectionInputReader, "read", original)
        assert (
            client.get("/api/projection?scenario_id=1").json()["basis"]
            != expected_before["basis"]
        )
        assert not hasattr(client.app.state, "conn")


@pytest.mark.parametrize(
    "path,body",
    [
        ("/api/accounts", {"name": "new", "type": "asset"}),
        ("/api/scenarios", {"name": "new", "fork_date": "2026-09-01"}),
        ("/api/materialize", None),
    ],
)
def test_two_connection_busy_error_has_context_and_no_partial_write(
    tmp_path, monkeypatch, path, body
):
    with TestClient(create_app(str(tmp_path / "api.db"))) as client:
        writer = connect(client.app.state.db_path)
        original = dependencies.connect
        connections = []

        def short_timeout(db):
            conn = original(db)
            conn.execute("PRAGMA busy_timeout=10")
            connections.append(conn)
            return conn

        monkeypatch.setattr(dependencies, "connect", short_timeout)
        before = snapshot(writer)
        ready, release = Barrier(2), Barrier(2)

        def hold_writer():
            writer.execute("BEGIN IMMEDIATE")
            ready.wait(timeout=5)
            release.wait(timeout=5)
            writer.rollback()

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(hold_writer)
            ready.wait(timeout=5)
            try:
                response = client.post(path, json=body)
                assert response.status_code == 503
                assert response.json()["detail"] == {
                    "code": "database_busy",
                    "message": "데이터베이스가 사용 중입니다. 잠시 후 다시 시도하세요",
                    "retryable": True,
                }
            finally:
                release.wait(timeout=5)
            pending.result(timeout=5)
        assert snapshot(writer) == before
        writer.close()
        for conn in connections:
            with pytest.raises(sqlite3.ProgrammingError, match="closed"):
                conn.execute("SELECT 1")


def test_nested_uow_rejection_does_not_rollback_outer_work(ledger):
    with SqliteUnitOfWork(ledger) as outer:
        outer.scenarios.save(Scenario(name="outer", base_scenario_id=1, fork_date=DAY))
        with pytest.raises(RuntimeError, match="idle"):
            with SqliteUnitOfWork(ledger):
                pytest.fail("Nested transaction must be rejected")
        assert ledger.in_transaction
    assert (
        ledger.execute("SELECT name FROM scenarios WHERE name='outer'").fetchone()[0]
        == "outer"
    )


def test_uow_rolls_back_interruption(ledger):
    before = snapshot(ledger)
    with pytest.raises(KeyboardInterrupt):
        with SqliteUnitOfWork(ledger) as uow:
            uow.scenarios.save(
                Scenario(name="interrupted", base_scenario_id=1, fork_date=DAY)
            )
            raise KeyboardInterrupt()
    assert not ledger.in_transaction
    assert snapshot(ledger) == before


def test_rule_edit_preserves_concurrently_materialized_watermark(tmp_path, monkeypatch):
    with TestClient(create_app(str(tmp_path / "api.db"))) as client:
        cash = client.post(
            "/api/accounts", json={"name": "cash", "type": "asset"}
        ).json()["id"]
        income = client.post(
            "/api/accounts", json={"name": "income", "type": "income"}
        ).json()["id"]
        today = datetime.date.today()
        body = {
            "from_account_id": income,
            "to_account_id": cash,
            "amount": 100,
            "schedule": f"monthly:{today.day}",
            "start_date": today.isoformat(),
            "end_date": today.isoformat(),
        }
        rule_id = client.post("/api/rules", json=body).json()["id"]
        read, materialized = Barrier(2), Barrier(2)
        original = SqliteRecurringRuleRepository.find_by_scenario
        pause_next_read = True

        def paused_read(repo, scenario_id):
            nonlocal pause_next_read
            result = original(repo, scenario_id)
            if pause_next_read:
                pause_next_read = False
                read.wait(timeout=5)
                materialized.wait(timeout=5)
            return result

        monkeypatch.setattr(
            SqliteRecurringRuleRepository, "find_by_scenario", paused_read
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(client.put, f"/api/rules/{rule_id}", json=body)
            read.wait(timeout=5)
            try:
                assert client.post("/api/materialize").json()["created"] == 1
            finally:
                materialized.wait(timeout=5)
            updated = pending.result(timeout=5)
        assert updated.status_code == 200
        assert updated.json()["last_materialized"] == today.isoformat()
        assert client.post("/api/materialize").json()["created"] == 0
        assert len(client.get("/api/transactions").json()) == 1


def test_materialization_locks_rules_before_planning(ledger, monkeypatch):
    from moneymap.adapters.sqlite import materialization
    from moneymap.domain.errors import DomainUnavailableError

    saved = SqliteRecurringRuleRepository(ledger).save(rule())
    db_path = ledger.execute("PRAGMA database_list").fetchone()["file"]
    editor = connect(db_path)
    editor.execute("PRAGMA busy_timeout=10")
    planned, release = Barrier(2), Barrier(2)
    original = materialization.plan_materialization

    def paused(rules, *, today):
        result = original(rules, today=today)
        planned.wait(timeout=5)
        release.wait(timeout=5)
        return result

    monkeypatch.setattr(materialization, "plan_materialization", paused)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(materialization.materialize_actual, ledger, DAY)
            planned.wait(timeout=5)
            try:
                edited = saved.model_copy(update={"amount": Money(amount=200)})
                with pytest.raises(DomainUnavailableError) as error:
                    SqliteRecurringRuleRepository(editor).save(edited)
                assert error.value.code == "database_busy"
            finally:
                release.wait(timeout=5)
            ids, _ = pending.result(timeout=5)
        assert len(ids) == 1
        updated = SqliteRecurringRuleRepository(editor).save(edited)
        assert updated.amount.amount == 200
        assert updated.last_materialized == DAY
        assert (
            ledger.execute("SELECT amount FROM postings WHERE account_id=2").fetchone()[
                "amount"
            ]
            == 100
        )
        monkeypatch.setattr(materialization, "plan_materialization", original)
        assert materialization.materialize_actual(ledger, DAY)[0] == []
    finally:
        editor.close()


def test_transaction_writer_rejects_idle_connection_and_existing_id(ledger):
    txn = Transaction(
        scenario_id=1,
        date=DAY,
        postings=[
            Posting(account_id=2, amount=Money(amount=100)),
            Posting(account_id=3, amount=Money(amount=-100)),
        ],
    )
    before = snapshot(ledger)
    with pytest.raises(RuntimeError, match="UnitOfWork"):
        SqliteUnitOfWork(ledger).transactions.save(txn)
    with pytest.raises(NotImplementedError):
        with SqliteUnitOfWork(ledger) as uow:
            uow.transactions.save(txn.model_copy(update={"id": 42}))
    assert snapshot(ledger) == before
