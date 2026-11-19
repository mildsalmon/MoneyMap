"""Persisted balances must always equal the ledger, including raw SQL writes."""
import datetime as dt
import random
from collections import defaultdict
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, init_db, SqliteAccountRepository, SqliteLedgerQueries, SqliteTransactionRepository
from moneymap.adapters.sqlite import database
from moneymap.adapters.sqlite.balance_history import selected_balances_after
from moneymap.api import create_app
from moneymap.domain import Account, AccountType


@pytest.fixture
def ledger(tmp_path):
    c = connect(str(tmp_path / 'ledger.db')); init_db(c)
    repo = SqliteAccountRepository(c)
    ids = [repo.create(Account(name=name, type=kind)).id for name, kind in
           [('통장', AccountType.ASSET), ('비용', AccountType.EXPENSE), ('카드', AccountType.LIABILITY)]]
    yield c, ids
    c.close()


def insert(c, ids, amount=100, day='2026-09-15', currency='KRW', scenario=1):
    tid = c.execute('INSERT INTO transactions(scenario_id,date) VALUES(?,?)', (scenario, day)).lastrowid
    c.executemany('INSERT INTO postings(txn_id,account_id,amount,currency) VALUES(?,?,?,?)',
                  [(tid, ids[0], amount, currency), (tid, ids[1], -amount, currency)])
    c.execute('UPDATE transactions SET posted=1 WHERE id=?', (tid,))
    return tid


def assert_matches_ledger(c):
    # An independent Python fold, not the trigger or SQL window algorithm.
    groups = defaultdict(int)
    for r in c.execute('SELECT t.id,t.date,p.account_id,p.currency,p.amount FROM transactions t JOIN postings p ON p.txn_id=t.id WHERE t.posted=1 AND t.scenario_id=1'):
        groups[(r['date'], r['id'], r['account_id'], r['currency'])] += r['amount']
    totals = defaultdict(int); expected = []
    for (date, tid, aid, currency), amount in sorted(groups.items()):
        totals[aid, currency] += amount
        expected.append((date, tid, aid, currency, amount, totals[aid, currency]))
    actual = [tuple(r) for r in c.execute('SELECT date,txn_id,account_id,currency,delta,balance FROM account_balance_history ORDER BY date,txn_id,account_id,currency')]
    assert actual == expected


def test_same_day_split_backdate_move_accounts_delete_and_rollback(ledger):
    c, ids = ledger
    with c:
        a = insert(c, ids, 100, '2026-09-15')
        b = insert(c, ids, 50, '2026-09-15')
        early = insert(c, ids, 20, '2026-09-01')
    assert_matches_ledger(c)
    assert selected_balances_after(c, [a, b], ids[0], False) == {
        a: [{'currency': 'KRW', 'amount': '120'}], b: [{'currency': 'KRW', 'amount': '170'}]}
    with c:
        c.execute('UPDATE transactions SET posted=0 WHERE id=?', (a,))
        c.execute('UPDATE postings SET account_id=? WHERE txn_id=? AND account_id=?', (ids[2], a, ids[0]))
        c.execute("UPDATE transactions SET date='2026-08-01',posted=1 WHERE id=?", (a,))
    assert_matches_ledger(c)
    before = [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')]
    c.execute('BEGIN')
    insert(c, ids, 999, '2020-01-01')
    c.execute('UPDATE transactions SET posted=0 WHERE id=?', (b,))
    c.rollback()
    assert [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')] == before
    SqliteTransactionRepository(c).delete(early)
    assert_matches_ledger(c)
    # Posting multiple legs to the same account nets once per transaction.
    with c:
        tid = c.execute("INSERT INTO transactions(scenario_id,date) VALUES(1,'2026-09-16')").lastrowid
        c.executemany('INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)', [(tid, ids[0], 100), (tid, ids[0], -40), (tid, ids[1], -60)])
        c.execute('UPDATE transactions SET posted=1 WHERE id=?', (tid,))
    assert_matches_ledger(c)


def test_random_edits_scenario_moves_currencies_and_metadata(ledger):
    c, ids = ledger; rng = random.Random(2718)
    with c:
        c.execute("INSERT INTO scenarios(id,name) VALUES(2,'별도')")
        live = [insert(c, ids, rng.randrange(-500, 500), f'2026-09-{rng.randrange(1,29):02d}', rng.choice(['KRW', 'USD', 'JPY'])) for _ in range(40)]
    for _ in range(60):
        tid = rng.choice(live)
        with c:
            if rng.randrange(3) == 0:
                c.execute('UPDATE transactions SET scenario_id=? WHERE id=?', (rng.choice([1, 2]), tid))
            else:
                c.execute('UPDATE transactions SET posted=0 WHERE id=?', (tid,))
                c.execute('UPDATE postings SET account_id=? WHERE txn_id=? AND amount>=0', (rng.choice(ids), tid))
                c.execute('UPDATE transactions SET date=?,posted=1 WHERE id=?', (f'2026-09-{rng.randrange(1,29):02d}', tid))
        assert_matches_ledger(c)
    before = [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')]
    with c:
        c.execute("UPDATE transactions SET description='메타데이터',memo='메모'")
        c.execute("UPDATE accounts SET name='새 이름',archived=1 WHERE id=?", (ids[0],))
    assert [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')] == before
    for aid in ids:
        raw = c.execute('SELECT COALESCE(SUM(p.amount),0) FROM postings p JOIN transactions t ON t.id=p.txn_id WHERE p.account_id=? AND t.scenario_id=1 AND t.posted=1', (aid,)).fetchone()[0]
        assert SqliteLedgerQueries(c).balances_at(dt.date(2026, 9, 30), 1).get(aid, 0) == raw


def test_group_internal_transfer_archive_hidden_period_tag_and_readonly(ledger):
    c, ids = ledger; repo = SqliteAccountRepository(c)
    group = repo.create(Account(name='그룹', type=AccountType.ASSET, is_placeholder=True)).id
    child = repo.create(Account(name='하위', type=AccountType.ASSET, parent_id=group)).id
    with c:
        early = insert(c, [child, ids[1]], 1000, '2026-08-01')
        first = insert(c, [child, ids[1]], -300)
        internal = insert(c, [child, group], -200)
        c.execute('UPDATE accounts SET archived=1 WHERE id=?', (child,))
    before = c.total_changes
    rows = selected_balances_after(c, [first, internal], group, True)
    assert rows[first] == rows[internal] == [{'currency': 'KRW', 'amount': '700'}]
    assert selected_balances_after(c, [internal], group, False)[internal] == [{'currency': 'KRW', 'amount': '200'}]
    assert c.total_changes == before
    assert early < first < internal


def test_balance_batch_is_one_read_and_all_transactions_are_three_reads(ledger):
    c, ids = ledger
    with c:
        for i in range(10): insert(c, ids, i + 1)
        c.execute("INSERT INTO tags(name,name_key) VALUES('태그','태그')")
        c.execute('INSERT INTO transaction_tags SELECT id,1 FROM transactions')
    queries = []; c.set_trace_callback(queries.append)
    before = c.total_changes
    balances = SqliteLedgerQueries(c).balances_at(dt.date(2026, 9, 15), 1)
    assert balances[ids[0]] == 55 and balances[ids[1]] == -55
    assert len(queries) == 1 and 'idx_balance_history_order' in ' '.join(str(tuple(r)) for r in c.execute('EXPLAIN QUERY PLAN ' + queries[0]))
    queries.clear()
    txns = SqliteTransactionRepository(c).find_by_scenario(1, dt.date(2026, 9, 15), dt.date(2026, 9, 15))
    assert len(queries) == 3 and len(txns) == 10
    assert all(t.tags == ['태그'] and len(t.postings) == 2 for t in txns)
    assert not SqliteTransactionRepository(c).find_by_scenario(1, dt.date(2027, 1, 1))
    c.set_trace_callback(None)
    assert c.total_changes == before


def test_v8_migration_backfills_preserves_and_rolls_back(tmp_path):
    c = connect(str(tmp_path / 'old.db')); old = database.MIGRATIONS
    with patch.object(database, 'MIGRATIONS', old[:8]): init_db(c)
    repo = SqliteAccountRepository(c)
    ids = [repo.create(Account(name=n, type=AccountType.ASSET)).id for n in ['A', 'B']]
    with c:
        insert(c, ids, 100)
        insert(c, ids, -10, '2026-01-01', 'USD')
    before = [tuple(r) for r in c.execute('SELECT * FROM postings')]
    def fail(conn):
        old[8](conn)
        raise RuntimeError('migration failure')
    with patch.object(database, 'MIGRATIONS', (*old[:8], fail)):
        with pytest.raises(RuntimeError): init_db(c)
    assert c.execute('PRAGMA user_version').fetchone()[0] == 8
    assert not c.execute("SELECT 1 FROM sqlite_master WHERE name='account_balance_history'").fetchone()
    init_db(c); assert_matches_ledger(c); init_db(c)
    assert c.execute('PRAGMA user_version').fetchone()[0] == 9
    assert [tuple(r) for r in c.execute('SELECT * FROM postings')] == before
    assert c.execute('PRAGMA foreign_key_check').fetchall() == []
    c.close()


def test_request_history_page_tag_and_balances_share_posted_snapshot(tmp_path):
    path = str(tmp_path / 'api.db'); c = connect(path); init_db(c)
    repo = SqliteAccountRepository(c)
    ids = [repo.create(Account(name=n, type=AccountType.ASSET)).id for n in ['A', 'B']]
    with c:
        insert(c, ids, 1000, '2026-08-01')
        selected = insert(c, ids, -30)
        insert(c, ids, -20)
        c.execute("INSERT INTO tags(name,name_key) VALUES('선택','선택')")
        c.execute('INSERT INTO transaction_tags VALUES(?,1)', (selected,))
    with TestClient(create_app(path)) as client:
        body = client.get('/api/transaction-history', params=dict(start='2026-09-15', end='2026-09-15', account_id=ids[0], tag='선택')).json()
        assert len(body['items']) == 1 and body['items'][0]['balance_after'] == [{'amount': '970', 'currency': 'KRW'}]
        assert next(a for a in client.get('/api/balances', params=dict(at='2026-08-01')).json()['accounts'] if a['account_id'] == ids[0])['balance'] == 1000
        read = connect(path); read.execute('BEGIN')
        before = SqliteLedgerQueries(read).balances_at(dt.date(2026, 9, 30), 1)
        with c: insert(c, ids, 123)
        assert SqliteLedgerQueries(read).balances_at(dt.date(2026, 9, 30), 1) == before
        read.rollback()
        assert SqliteLedgerQueries(read).balances_at(dt.date(2026, 9, 30), 1)[ids[0]] == before[ids[0]] + 123
        read.close()
    c.close()


def test_overflow_rejects_append_and_delete_without_corrupting_balances(ledger):
    import sqlite3
    c, ids = ledger; unit = 9_007_199_254_740_991
    with c:
        for _ in range(1024): insert(c, ids, unit)
    before = [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')]
    with pytest.raises(sqlite3.IntegrityError, match='balance_history_integer'):
        with c: insert(c, ids, unit)
    assert [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')] == before
    assert_matches_ledger(c)
    with c:
        early = insert(c, ids, -unit, '2026-01-01')
        insert(c, ids, unit)
    # Deleting an old negative entry can overflow a later balance too.
    before = [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')]
    with pytest.raises(sqlite3.IntegrityError, match='balance_history_integer'):
        SqliteTransactionRepository(c).delete(early)
    assert [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')] == before
    assert c.execute('SELECT posted FROM transactions WHERE id=?', (early,)).fetchone()[0] == 1
    assert_matches_ledger(c)
    # An unchanged financial edit must not transiently remove the old negative
    # entry, which would overflow even though its final ledger is unchanged.
    import uuid
    from moneymap.domain.transaction_edit import TransactionEdit
    repo = SqliteTransactionRepository(c); detail = repo.find_edit_detail(early)
    command = TransactionEdit(expected_version=detail.version, request_id=str(uuid.uuid4()),
        date=detail.date, description=detail.description, memo='메모만 수정', tags=['확인'],
        postings=[p.model_dump(exclude={'currency'}) for p in detail.postings])
    assert repo.update(early, command)['transaction']['memo'] == '메모만 수정'
    assert [tuple(r) for r in c.execute('SELECT * FROM account_balance_history')] == before
    with TestClient(create_app(c.execute('PRAGMA database_list').fetchone()[2])) as client:
        response = client.post('/api/transactions', json=dict(date='2026-09-15', postings=[
            dict(account_id=ids[0], amount=unit), dict(account_id=ids[1], amount=-unit)]))
        assert response.status_code == 400
        assert response.json()['detail']['code'] == 'balance_history_integer'
    assert_matches_ledger(c)


def test_group_aggregation_exceeds_int64_without_losing_precision(ledger):
    c, ids = ledger; repo = SqliteAccountRepository(c)
    group = repo.create(Account(name='큰 그룹', type=AccountType.ASSET, is_placeholder=True)).id
    leaves = [repo.create(Account(name=f'자식{i}', type=AccountType.ASSET, parent_id=group)).id for i in range(2)]
    with c:
        insert(c, [leaves[0], ids[0]], 5_000_000_000_000_000_000)
        latest = insert(c, [leaves[1], ids[1]], 5_000_000_000_000_000_000)
    assert selected_balances_after(c, [latest], group, True)[latest] == [
        {'currency': 'KRW', 'amount': '10000000000000000000'}]
    assert_matches_ledger(c)
