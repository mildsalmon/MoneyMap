"""Upgrade the PR1 schema with rollback and explicit legacy date decisions."""

import sqlite3
from pathlib import Path

import pytest

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite import database

FORK = "2026-09-01"
LEGACY_SCHEMA = Path(__file__).parent / "fixtures" / "legacy_schema.sql"


@pytest.fixture
def pr1(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "MIGRATIONS", database.MIGRATIONS[:2])
    conn = connect(str(tmp_path / "pr1.db"))
    conn.executescript(LEGACY_SCHEMA.read_text())
    with conn:
        database.MIGRATIONS[0](conn)
        conn.execute("PRAGMA user_version=1")
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 1
    assert "rule_mode" not in {
        r["name"] for r in conn.execute("PRAGMA table_info(scenarios)")
    }
    try:
        yield conn
    finally:
        conn.close()


def add_rule(conn, owner):
    return conn.execute(
        "INSERT INTO recurring_rules(scenario_id,from_account_id,to_account_id,amount,schedule,start_date) VALUES(?,3,2,100,'monthly:1','2026-01-01')",
        (owner,),
    ).lastrowid


def add_transaction(conn, day, source=None):
    tid = conn.execute(
        "INSERT INTO transactions(scenario_id,date,source_rule_id) VALUES(2,?,?)",
        (day, source),
    ).lastrowid
    conn.executemany(
        "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
        [(tid, 2, 100), (tid, 3, -100)],
    )
    conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (tid,))
    return tid


def data(conn):
    return {
        table: [
            tuple(row) for row in conn.execute(("SELECT id,scenario_id,date,description,source_rule_id,posted FROM transactions ORDER BY id" if table == "transactions" else f"SELECT * FROM {table} ORDER BY id"))
        ]
        for table in (
            "accounts",
            "scenarios",
            "recurring_rules",
            "transactions",
            "postings",
        )
    }


def schema(conn):
    return [
        tuple(row)
        for row in conn.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
        )
    ]


def test_migration_two_failure_restores_pr1_schema_data_and_version_then_retries(pr1):
    with pr1:
        rid = add_rule(pr1, 2)
        add_transaction(pr1, FORK, rid)
        # The failure follows ALTER TABLE, revision triggers, mode classification,
        # unposting and the first posting removal inside migration 2.
        pr1.execute(
            "CREATE TRIGGER injected_migration_failure AFTER DELETE ON postings BEGIN SELECT RAISE(ABORT,'injected migration 2'); END"
        )
    before, before_schema = data(pr1), schema(pr1)
    with pytest.raises(sqlite3.IntegrityError, match="injected migration 2"):
        init_db(pr1)
    assert not pr1.in_transaction
    assert pr1.execute("PRAGMA user_version").fetchone()[0] == 1
    assert data(pr1) == before
    assert schema(pr1) == before_schema
    assert pr1.execute("SELECT posted FROM transactions").fetchone()[0] == 1
    assert pr1.execute("PRAGMA foreign_key_check").fetchall() == []

    pr1.execute("DROP TRIGGER injected_migration_failure")
    init_db(pr1)
    assert pr1.execute("PRAGMA user_version").fetchone()[0] == len(database.MIGRATIONS)
    assert (
        pr1.execute("SELECT rule_mode FROM scenarios WHERE id=2").fetchone()[0]
        == "live_additive"
    )
    assert pr1.execute("SELECT count(*) FROM transactions").fetchone()[0] == 0
    assert pr1.execute("SELECT count(*) FROM postings").fetchone()[0] == 0
    assert data(pr1)["recurring_rules"] == before["recurring_rules"]
    assert pr1.execute("SELECT next_id FROM scenario_id_sequence").fetchone()[0] == 3
    after, after_schema = data(pr1), schema(pr1)
    init_db(pr1)
    assert data(pr1) == after and schema(pr1) == after_schema


@pytest.mark.parametrize(
    "owner", [None, 1, 2], ids=["no_rules", "actual_only", "scenario_only"]
)
@pytest.mark.parametrize("day", ["2026-08-31", FORK], ids=["before_fork", "on_fork"])
def test_manual_date_conflict_preserves_legacy_even_without_clone_ambiguity(
    pr1, owner, day
):
    with pr1:
        if owner is not None:
            add_rule(pr1, owner)
        add_transaction(pr1, day)
    before = data(pr1)
    init_db(pr1)
    after = data(pr1)
    assert pr1.execute("PRAGMA user_version").fetchone()[0] == len(database.MIGRATIONS)
    assert (
        pr1.execute("SELECT rule_mode FROM scenarios WHERE id=2").fetchone()[0]
        == "legacy_snapshot"
    )
    assert (
        pr1.execute("SELECT rule_mode FROM scenarios WHERE id=1").fetchone()[0]
        == "live_additive"
    )
    for table in ("accounts", "recurring_rules", "transactions", "postings"):
        assert after[table] == before[table]
    assert [row[:5] for row in after["scenarios"]] == before["scenarios"]
    assert pr1.execute("PRAGMA foreign_key_check").fetchall() == []


@pytest.mark.parametrize("planned", [False, True], ids=["empty", "planned_after_fork"])
def test_no_rules_and_no_date_conflict_automatically_becomes_live(pr1, planned):
    if planned:
        with pr1:
            add_transaction(pr1, "2026-09-02")
    before = data(pr1)
    init_db(pr1)
    assert (
        pr1.execute("SELECT rule_mode FROM scenarios WHERE id=2").fetchone()[0]
        == "live_additive"
    )
    after = data(pr1)
    for table in ("accounts", "recurring_rules", "transactions", "postings"):
        assert after[table] == before[table]
    assert pr1.execute("PRAGMA foreign_key_check").fetchall() == []
