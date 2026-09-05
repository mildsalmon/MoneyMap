"""Upgrade a real v2 ledger, with fault injection at every new schema phase."""
import sqlite3
import unicodedata
from pathlib import Path

import pytest

from moneymap.adapters.sqlite import connect, init_db, database
from moneymap.adapters.sqlite.transaction_input import SqliteTransactionInputQueries
from moneymap.app_services.transaction_input import last_pair


@pytest.fixture
def v3(tmp_path):
    conn = connect(str(tmp_path / 'v3.db'))
    conn.executescript((Path(__file__).parent / 'fixtures/legacy_schema.sql').read_text())
    with conn:
        for migration in database.MIGRATIONS[:3]:
            migration(conn)
        conn.execute('PRAGMA user_version=3')
        rid = conn.execute("INSERT INTO recurring_rules(scenario_id,from_account_id,to_account_id,amount,schedule,start_date) VALUES(1,3,2,100,'monthly:1','2026-01-01')").lastrowid
        for origin, pair, source, scenario in [('opening', (2, 1), None, 1), ('rule', (2, 3), rid, 1), ('deleted-rule', (2, 3), None, 1), ('manual', (2, 3), None, 1), ('scenario', (2, 3), None, 2)]:
            tid = conn.execute('INSERT INTO transactions(scenario_id,date,description,source_rule_id) VALUES(?,?,?,?)', (scenario, '2026-09-01', ' '+unicodedata.normalize('NFD','점심')+' '+origin+' ', source)).lastrowid
            conn.executemany('INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)', [(tid,pair[0],100),(tid,pair[1],-100)])
            conn.execute('UPDATE transactions SET posted=1 WHERE id=?',(tid,))
    yield conn
    conn.close()


def snapshot(conn):
    return [tuple(row) for row in conn.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name')], [tuple(row) for row in conn.execute('SELECT * FROM transactions')], [tuple(row) for row in conn.execute('SELECT * FROM postings')]


def test_backfill_exact_key_origins_legacy_confirmation_and_blank_memo(v3):
    before = snapshot(v3)
    init_db(v3)
    rows = list(v3.execute('SELECT * FROM transactions ORDER BY id'))
    assert [r['entry_origin'] for r in rows] == ['system','rule','legacy_unknown','legacy_unknown','legacy_unknown']
    assert all(r['memo']=='' and r['item_key']==unicodedata.normalize('NFC',r['description']).strip() for r in rows)
    assert [tuple(r)[:6] for r in rows] == before[1]
    assert [tuple(r) for r in v3.execute('SELECT * FROM postings')] == before[2]
    q = SqliteTransactionInputQueries(v3)
    assert last_pair(q,'점심 manual').status == 'legacy_confirmation_required'
    assert last_pair(q,'점심 deleted-rule').status == 'legacy_confirmation_required'
    assert last_pair(q,'점심 scenario').status == 'none'
    unchanged = snapshot(v3)
    init_db(v3)
    assert snapshot(v3) == unchanged
    assert v3.execute('PRAGMA foreign_key_check').fetchall() == []


@pytest.mark.parametrize('phase',['origin-column','memo-column','backfill','item-index','recent-index'])
def test_migration_four_failure_restores_schema_data_and_version_then_retries(v3, phase):
    before = snapshot(v3)
    # Authorizer cannot see ALTER's column, so fail by its ordered invocation.
    alter_count = 0
    def authorizer(action, table, column, *_):
        nonlocal alter_count
        if action == sqlite3.SQLITE_ALTER_TABLE:
            alter_count += 1
            if (phase=='origin-column' and alter_count==2) or (phase=='memo-column' and alter_count==3):
                return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_UPDATE and table=='transactions' and column=='entry_origin' and phase=='backfill':
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_CREATE_INDEX and table=={'item-index':'idx_txn_input_item','recent-index':'idx_txn_input_recent'}.get(phase):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    v3.set_authorizer(authorizer)
    with pytest.raises(sqlite3.DatabaseError):
        init_db(v3)
    v3.set_authorizer(None)
    assert not v3.in_transaction
    assert v3.execute('PRAGMA user_version').fetchone()[0] == 3
    assert snapshot(v3) == before
    init_db(v3)
    assert v3.execute('PRAGMA user_version').fetchone()[0] == 4
    assert v3.execute('SELECT count(*) FROM transactions WHERE memo=""').fetchone()[0] == 5
