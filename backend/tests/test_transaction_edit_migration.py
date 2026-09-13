import sqlite3

import pytest

from moneymap.adapters.sqlite import database, connect, init_db


def old_db(tmp_path):
    conn = connect(str(tmp_path / "old.db"))
    with conn:
        for migration in database.MIGRATIONS[:5]:
            migration(conn)
        conn.execute("PRAGMA user_version=5")
        conn.execute("INSERT INTO transactions(scenario_id,date,description,posted) VALUES(1,'2020-01-01','old',0)")
    return conn


def test_migrate_revision_receipts_preserves_old_data_and_is_idempotent(tmp_path):
    conn = old_db(tmp_path)
    before = tuple(conn.execute("SELECT id,date,description,entry_origin FROM transactions").fetchone())
    init_db(conn)
    assert tuple(conn.execute("SELECT id,date,description,entry_origin FROM transactions").fetchone()) == before
    version = conn.execute("SELECT edit_version FROM transactions").fetchone()[0]
    assert len(version) == 32
    init_db(conn)
    assert conn.execute("SELECT edit_version FROM transactions").fetchone()[0] == version
    columns = {r[1] for r in conn.execute("PRAGMA table_info(transaction_edit_requests)")}
    assert columns == {"request_id", "txn_id", "expected_version", "payload_hash", "outcome", "result_version"}
    assert list((tmp_path / "backups").iterdir())
    conn.close()


def test_migration_failure_rolls_back_schema_and_version(tmp_path, monkeypatch):
    conn = old_db(tmp_path)
    migration = database.MIGRATIONS[5]
    def fail(c):
        migration(c)
        raise RuntimeError("injected migration failure")
    monkeypatch.setattr(database, "MIGRATIONS", (*database.MIGRATIONS[:5], fail))
    with pytest.raises(RuntimeError, match="injected"):
        init_db(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 5
    assert "edit_version" not in {r[1] for r in conn.execute("PRAGMA table_info(transactions)")}
    assert conn.execute("SELECT name FROM sqlite_master WHERE name='transaction_edit_requests'").fetchone() is None
    conn.close()
