"""PR1 migration gate: frozen legacy data, durable backup, per-version rollback."""

import datetime
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite import backup, database
from moneymap.api import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "legacy_schema.sql"


def legacy_db(path, mode="both", generated=False):
    conn = connect(str(path))
    conn.executescript(FIXTURE.read_text())
    for sid in {"none": [], "actual": [1], "scenario": [2], "both": [1, 2]}[mode]:
        conn.execute(
            "INSERT INTO recurring_rules(id,scenario_id,from_account_id,to_account_id,amount,schedule,start_date) VALUES(?,?,3,2,100,'monthly:1','2026-01-01')",
            (sid, sid),
        )
    if generated:
        # Before fork, at fork, after fork: classification belongs to PR2, preserve all here.
        for day in ("2026-08-01", "2026-09-01", "2026-10-01"):
            tid = conn.execute(
                "INSERT INTO transactions(scenario_id,date,source_rule_id,posted) VALUES(2,?,2,1)",
                (day,),
            ).lastrowid
            conn.executemany(
                "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
                [(tid, 2, 100), (tid, 3, -100)],
            )
    conn.commit()
    return conn


def rows(conn):
    return {
        table: [tuple(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY id")]
        for table in ("scenarios", "recurring_rules", "transactions", "postings")
    }


@pytest.mark.parametrize(
    "mode,generated",
    [
        ("none", False),
        ("actual", False),
        ("scenario", False),
        ("both", False),
        ("scenario", True),
        ("both", True),
    ],
)
def test_legacy_matrix_backup_restore_and_idempotence(tmp_path, mode, generated):
    conn = legacy_db(tmp_path / "ledger.db", mode, generated)
    try:
        before = rows(conn)
        backup_dir = tmp_path / "backups"
        backup.run_daily_backup(conn, backup_dir, datetime.date.today())
        init_db(conn)
        migrated = rows(conn)
        assert [row[:5] for row in migrated["scenarios"]] == before["scenarios"]
        assert migrated["recurring_rules"] == before["recurring_rules"]
        if generated and mode == "scenario":
            assert migrated["transactions"] == migrated["postings"] == []
        else:
            assert migrated["transactions"] == before["transactions"]
            assert migrated["postings"] == before["postings"]
        expected_mode = "legacy_snapshot" if mode == "both" else "live_additive"
        assert (
            conn.execute("SELECT rule_mode FROM scenarios WHERE id=2").fetchone()[0]
            == expected_mode
        )
        assert conn.execute("PRAGMA user_version").fetchone()[0] == len(
            database.MIGRATIONS
        )
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        copies = list(backup_dir.glob("migration-*.db"))
        assert (
            len(copies) == 1
        )  # Today's daily backup cannot suppress migration backup.
        saved = copies[0]
        manifest = json.loads(saved.with_suffix(".db.sha256.json").read_text())
        assert manifest["sha256"] == hashlib.sha256(saved.read_bytes()).hexdigest()
        restored = connect(str(saved))
        try:
            assert restored.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert restored.execute("PRAGMA user_version").fetchone()[0] == 0
            assert rows(restored) == before
            init_db(restored)
            assert rows(restored) == migrated
        finally:
            restored.close()
        init_db(conn)
        assert list(backup_dir.glob("migration-*.db")) == copies
        backup.run_daily_backup(
            conn, backup_dir, datetime.date.today() + datetime.timedelta(days=1), keep=1
        )
        assert saved.exists()
    finally:
        conn.close()


def test_migration_failure_rolls_back_schema_data_and_version(tmp_path, monkeypatch):
    conn = legacy_db(tmp_path / "ledger.db")
    before = rows(conn)
    original = database.MIGRATIONS[0]

    def fail_after_ddl(c):
        original(c)
        c.execute("UPDATE scenarios SET name='changed' WHERE id=2")
        c.execute("INSERT INTO no_such_table VALUES(1)")

    monkeypatch.setattr(database, "MIGRATIONS", (fail_after_ddl,))
    with pytest.raises(sqlite3.OperationalError):
        init_db(conn)
    assert not conn.in_transaction
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    assert "position" not in {
        r["name"] for r in conn.execute("PRAGMA table_info(accounts)")
    }
    assert rows(conn) == before
    assert len(list((tmp_path / "backups").glob("migration-*.db"))) == 1
    conn.close()


def test_each_migration_owns_its_version_transaction(tmp_path, monkeypatch):
    conn = legacy_db(tmp_path / "ledger.db")

    def second(c):
        c.execute("CREATE TABLE second_step(id INTEGER)")
        raise RuntimeError("injected")

    monkeypatch.setattr(database, "MIGRATIONS", (*database.MIGRATIONS, second))
    with pytest.raises(RuntimeError, match="injected"):
        init_db(conn)
    assert (
        conn.execute("PRAGMA user_version").fetchone()[0]
        == len(database.MIGRATIONS) - 1
    )
    assert (
        conn.execute(
            "SELECT name FROM sqlite_master WHERE name='second_step'"
        ).fetchone()
        is None
    )
    conn.close()


@pytest.mark.parametrize(
    "failure", ["permission", "disk", "integrity", "fsync", "rename"]
)
def test_backup_failure_aborts_startup_before_schema_mutation(
    tmp_path, monkeypatch, failure
):
    path = tmp_path / "ledger.db"
    conn = legacy_db(path)
    before = rows(conn)
    conn.close()

    def fail(*args, **kwargs):
        raise OSError(f"injected {failure}")

    if failure == "permission":
        monkeypatch.setattr(Path, "mkdir", fail)
    elif failure == "disk":
        original = sqlite3.connect

        class DiskFailure(sqlite3.Connection):
            def backup(self, *args, **kwargs):
                fail()

        monkeypatch.setattr(
            database.sqlite3,
            "connect",
            lambda *a, **kw: original(*a, **kw, factory=DiskFailure),
        )
    elif failure == "integrity":
        original = sqlite3.connect

        class CorruptResult(sqlite3.Connection):
            def execute(self, sql, *args):
                if sql == "PRAGMA integrity_check":
                    return [("corrupt",)]
                return super().execute(sql, *args)

        monkeypatch.setattr(
            backup.sqlite3,
            "connect",
            lambda *a, **kw: original(*a, **kw, factory=CorruptResult),
        )
    else:
        import os

        monkeypatch.setattr(os, "fsync" if failure == "fsync" else "replace", fail)
    with pytest.raises((OSError, sqlite3.DatabaseError)):
        with TestClient(create_app(str(path))):
            pytest.fail("startup must abort")
    conn = connect(str(path))
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    assert rows(conn) == before
    assert "position" not in {
        r["name"] for r in conn.execute("PRAGMA table_info(accounts)")
    }
    assert not list((tmp_path / "backups").glob("migration-*.db"))
    conn.close()


def test_future_version_and_active_transaction_are_rejected(tmp_path):
    conn = connect(str(tmp_path / "ledger.db"))
    conn.execute("PRAGMA user_version=999")
    with pytest.raises(RuntimeError, match="newer"):
        init_db(conn)
    conn.execute("PRAGMA user_version=0")
    conn.execute("BEGIN")
    with pytest.raises(RuntimeError, match="idle"):
        init_db(conn)
    assert conn.in_transaction  # Runner must not commit the caller's work.
    conn.close()


def test_current_unversioned_schema_keeps_account_metadata(tmp_path):
    conn = connect(str(tmp_path / "ledger.db"))
    with conn:
        database.MIGRATIONS[0](conn)
    # Historical foundation schema has account columns and no user_version.
    conn.execute(
        "INSERT INTO accounts(id,name,type,is_overdraft,position,version) VALUES(2,'overdraft','asset',1,7,9)"
    )
    conn.execute("PRAGMA user_version=0")
    conn.commit()
    before = [tuple(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")]
    init_db(conn)
    assert [
        tuple(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")
    ] == before
    assert len(list((tmp_path / "backups").glob("migration-*.db"))) == 1
    conn.close()


def test_simultaneous_startups_apply_pending_migration_once(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    path = tmp_path / "ledger.db"
    conn = connect(str(path))
    init_db(conn)
    conn.close()
    ready = Barrier(2)
    original = backup.run_migration_backup

    def synchronize(*args):
        result = original(*args)
        ready.wait(timeout=5)
        return result

    def second(c):
        c.execute("CREATE TABLE applied_once(id INTEGER)")
        c.execute("INSERT INTO applied_once VALUES(1)")

    monkeypatch.setattr(backup, "run_migration_backup", synchronize)
    monkeypatch.setattr(database, "MIGRATIONS", (*database.MIGRATIONS, second))

    def start():
        c = connect(str(path))
        try:
            init_db(c)
        finally:
            c.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(start) for _ in range(2)]
        for task in tasks:
            task.result(timeout=10)
    conn = connect(str(path))
    assert conn.execute("SELECT COUNT(*) FROM applied_once").fetchone()[0] == 1
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(database.MIGRATIONS)
    conn.close()


@pytest.mark.parametrize(
    "operation,call_number", [("fsync", 2), ("fsync", 3), ("replace", 2)]
)
def test_late_backup_publication_failure_preserves_source(
    tmp_path, monkeypatch, operation, call_number
):
    import os

    path = tmp_path / "ledger.db"
    conn = legacy_db(path)
    before = rows(conn)
    conn.close()
    original = getattr(os, operation)
    calls = 0

    def fail_at_stage(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == call_number:
            raise OSError("injected publication failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(os, operation, fail_at_stage)
    with pytest.raises(OSError, match="publication failure"):
        with TestClient(create_app(str(path))):
            pytest.fail("Startup must fail")
    conn = connect(str(path))
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert "position" not in {
            r["name"] for r in conn.execute("PRAGMA table_info(accounts)")
        }
        assert rows(conn) == before
    finally:
        conn.close()
    published = list((tmp_path / "backups").glob("migration-*.db"))
    assert len(published) == (1 if operation == "fsync" and call_number == 3 else 0)
    for saved in published:
        manifest = json.loads(saved.with_suffix(".db.sha256.json").read_text())
        assert manifest["sha256"] == hashlib.sha256(saved.read_bytes()).hexdigest()
        restored = connect(str(saved))
        try:
            assert restored.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert rows(restored) == before
        finally:
            restored.close()
