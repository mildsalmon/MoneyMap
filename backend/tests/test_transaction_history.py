"""History reads: boundaries, all ledger kinds, bounded SQL and snapshots."""
import datetime as dt

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, init_db, SqliteAccountRepository, SqliteTransactionRepository
from moneymap.adapters.sqlite.transaction_history import SqliteTransactionHistory
from moneymap.api import create_app
from moneymap.domain import Account, AccountType, Money, Posting, Transaction


@pytest.fixture
def ledger(tmp_path):
    path = str(tmp_path / "history.db")
    conn = connect(path)
    init_db(conn)
    accounts = SqliteAccountRepository(conn)
    ids = [accounts.create(Account(name=n, type=t)).id for n, t in [
        ("현금", AccountType.ASSET), ("비용", AccountType.EXPENSE),
    ]]
    with TestClient(create_app(path)) as client:
        yield conn, ids, client
    conn.close()


def seed(conn, ids, count, day="2026-09-15"):
    # Synthetic rows in this fixture DB only. Keep all integrity triggers on.
    with conn:
        first = conn.execute("SELECT COALESCE(MAX(id),0)+1 FROM transactions").fetchone()[0]
        conn.executemany("INSERT INTO transactions(id,scenario_id,date,description) VALUES(?,1,?,?)",
                         [(first + i, day, f"거래 {i}") for i in range(count)])
        conn.executemany("INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
                         [(first + i, account, amount) for i in range(count) for account, amount in [(ids[0], -100), (ids[1], 100)]])
        conn.execute("UPDATE transactions SET posted=1 WHERE id>=?", (first,))
    return list(range(first, first + count))


def query(client, **params):
    return client.get("/api/transaction-history", params={"start": "2026-09-15", "end": "2026-09-15", **params})


@pytest.mark.parametrize("count", [0, 1, 100, 101, 201])
def test_count_order_full_walk_and_clamp(ledger, count):
    conn, ids, client = ledger
    expected = seed(conn, ids, count)[::-1]
    seen = []
    for page in range(1, max(1, (count + 99) // 100) + 1):
        response = query(client, page=page)
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == count and body["page_size"] == 100 and body["page"] == page
        assert len(body["items"]) <= 100
        seen.extend(t["id"] for t in body["items"])
    assert seen == expected
    last = query(client, page=10**30).json()
    assert last["page"] == last["total_pages"] == max(1, (count + 99) // 100)
    assert len(seen) == len(set(seen))


@pytest.mark.parametrize("params", [
    {"start": ""}, {"end": ""}, {"start": "2026-02-30"}, {"end": "20260915"},
    {"start": "2026-09-16"}, {"start": "2026-09-15T00:00:00"},
    {"page": 0}, {"page": -1}, {"page": "text"}, {"page": "1.5"},
])
def test_invalid_request_is_never_unbounded(ledger, params):
    assert query(ledger[2], **params).status_code == 422


def test_dates_required_and_inclusive_no_unposted_or_scenario(ledger):
    conn, ids, client = ledger
    assert client.get("/api/transaction-history").status_code == 422
    for day in ["2026-08-15", "2026-08-16", "2026-09-15", "2026-09-16"]:
        seed(conn, ids, 1, day)
    with conn:
        conn.execute("INSERT INTO transactions(scenario_id,date) VALUES(1,'2026-09-15')")
        conn.execute("INSERT INTO scenarios(id,name) VALUES(2,'별도')")
        other = seed(conn, ids, 1)[0]
        conn.execute("UPDATE transactions SET scenario_id=2 WHERE id=?", (other,))
    body = query(client, start="2026-08-16").json()
    assert [t["date"] for t in body["items"]] == ["2026-09-15", "2026-08-16"]


def test_tag_before_pagination_exact_name_and_preserves_existing_api(ledger):
    conn, ids, client = ledger
    seed(conn, ids, 205)
    with conn:
        conn.executemany("INSERT INTO tags(id,name,name_key) VALUES(?,?,?)", [(1, "여행 & Tea", "여행 & tea"), (2, "둘", "둘")])
        conn.executemany("INSERT INTO transaction_tags(txn_id,tag_id) VALUES(?,?)", [(i, 1) for i in range(1, 104)] + [(i, 2) for i in range(1, 206)])
    before = client.get("/api/transactions").json()
    body = query(client, tag="여행 & Tea", page=2).json()
    assert body["total"] == 103 and [t["id"] for t in body["items"]] == [3, 2, 1]
    assert all(t["tags"] == ["둘", "여행 & Tea"] for t in body["items"])
    for absent in ["여행 & tea", "없는 태그", "' OR 1=1 --"]:
        assert query(client, tag=absent).json()["total"] == 0
    assert client.get("/api/transactions").json() == before


def test_origins_refunds_zero_and_long_memo_are_not_filtered(ledger):
    conn, ids, client = ledger
    repo = SqliteTransactionRepository(conn)
    for amount in [0, -300, 500]:
        repo.save(Transaction(scenario_id=1, date=dt.date(2026, 9, 15), memo="긴 메모\n" * 1500,
            postings=[Posting(account_id=ids[0], amount=Money(amount=amount), legacy_zero=amount == 0),
                      Posting(account_id=ids[1], amount=Money(amount=-amount), legacy_zero=amount == 0)]))
    with conn:
        for tid, origin in [(1, "legacy_unknown"), (2, "rule"), (3, "system")]:
            conn.execute("UPDATE transactions SET entry_origin=? WHERE id=?", (origin, tid))
    before = client.get("/api/transactions").json()
    assert query(client).json()["items"] == before[::-1]
    assert query(client).json()["total"] == 3


def test_large_ledger_has_four_selects_and_existing_indexes(ledger):
    conn, ids, _ = ledger
    seed(conn, ids, 10_001)
    with conn:
        conn.execute("INSERT INTO tags(id,name,name_key) VALUES(1,'dense','dense')")
        conn.execute("INSERT INTO transaction_tags SELECT id,1 FROM transactions WHERE id%2=0")
    queries = []
    conn.set_trace_callback(queries.append)
    reader = SqliteTransactionHistory(conn)
    for tag, page in [("", 1), ("", 101), ("dense", 50), ("missing", 1)]:
        queries.clear()
        result = reader.page(dt.date(2026, 9, 15), dt.date(2026, 9, 15), tag, page)
        selects = [sql for sql in queries if sql.startswith("SELECT")]
        assert len(selects) == (4 if result["total"] else 1)
        assert len(result["items"]) <= 100
        for sql in selects[:2]:
            plan = " ".join(str(tuple(r)) for r in conn.execute("EXPLAIN QUERY PLAN " + sql))
            assert "idx_txn_scenario_date" in plan
            if tag == "dense":
                assert "idx_transaction_tags_tag" in plan
    conn.set_trace_callback(None)


def test_count_and_items_share_request_snapshot(ledger):
    conn, ids, client = ledger
    seed(conn, ids, 2)
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    writer = connect(path)
    from moneymap.dependencies import request_connection

    def injected(request: Request):
        read = connect(path)
        read.execute("BEGIN")
        request.state.conn = read
        fired = False
        def trace(sql):
            nonlocal fired
            if sql.startswith("SELECT t.*") and not fired:
                fired = True
                seed(writer, ids, 1)
        read.set_trace_callback(trace)
        try:
            yield read
        finally:
            read.rollback()
            read.close()
    client.app.dependency_overrides[request_connection] = injected
    try:
        body = query(client).json()
        assert body["total"] == len(body["items"]) == 2
        assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 3
    finally:
        client.app.dependency_overrides.clear()
        writer.close()


def test_account_subtree_direct_archived_split_and_tag_pagination(ledger):
    conn, ids, client = ledger
    repo = SqliteAccountRepository(conn)
    root = repo.create(Account(name='계정 그룹', type=AccountType.EXPENSE, is_placeholder=True)).id
    child = repo.create(Account(name='하위', type=AccountType.EXPENSE, parent_id=root)).id
    leaf = repo.create(Account(name='보관 후손', type=AccountType.EXPENSE, parent_id=child)).id
    unrelated = repo.create(Account(name='다른 계정', type=AccountType.EXPENSE)).id
    direct = seed(conn, [root, ids[0]], 1)[0]  # Historical direct group posting.
    children = seed(conn, [child, ids[0]], 105)
    archived = seed(conn, [leaf, ids[0]], 1)[0]
    split = seed(conn, [child, leaf], 1)[0]  # Matches two postings, one transaction.
    seed(conn, [unrelated, ids[0]], 2)
    with conn:
        conn.execute('UPDATE accounts SET archived=1 WHERE id=?', (leaf,))
        conn.execute("INSERT INTO tags(id,name,name_key) VALUES(50,'선택 태그','선택 태그')")
        conn.executemany('INSERT INTO transaction_tags(txn_id,tag_id) VALUES(?,50)', [(tid,) for tid in children[:103]])
    before = client.get('/api/transactions').json()
    first = query(client, account_id=root).json()
    second = query(client, account_id=root, page=2).json()
    assert first['total'] == 108
    assert [row['id'] for row in first['items'] + second['items']] == [split, archived, *children[::-1], direct]
    assert all(len(row['postings']) == 2 for row in first['items'])
    assert query(client, account_id=root, include_descendants=False).json()['items'][0]['id'] == direct
    assert query(client, account_id=root, include_descendants=False).json()['total'] == 1
    assert query(client, account_id=leaf).json()['total'] == 2
    assert query(client, account_id=root, tag='選択').json()['total'] == 0
    tagged = query(client, account_id=root, tag='선택 태그', page=2).json()
    assert tagged['total'] == 103 and [t['id'] for t in tagged['items']] == children[:3][::-1]
    assert query(client, account_id=unrelated).json()['total'] == 2
    assert client.get('/api/transactions').json() == before


@pytest.mark.parametrize('suffix', [
    '&account_id=0', '&account_id=-1', '&account_id=nope', '&account_id=9007199254740992',
    '&account_id=1&account_id=2', '&include_descendants=false',
    '&account_id=1&include_descendants=invalid', '&account_id=1&include_descendants=true&include_descendants=false',
])
def test_invalid_account_filter_never_falls_back_to_unfiltered(ledger, suffix):
    response = ledger[2].get('/api/transaction-history?start=2026-09-15&end=2026-09-15' + suffix)
    assert response.status_code == 422


def test_unknown_account_is_not_an_unfiltered_history_and_query_count_is_bounded(ledger):
    conn, ids, client = ledger
    assert query(client, account_id=999999).status_code == 404
    seed(conn, ids, 110)
    statements = []
    conn.set_trace_callback(statements.append)
    try:
        conn.execute('BEGIN')
        body = SqliteTransactionHistory(conn).page(dt.date(2026, 9, 15), dt.date(2026, 9, 15), '', 1, ids[0])
        assert body['total'] == 110 and len(body['items']) == 100
    finally:
        conn.rollback(); conn.set_trace_callback(None)
    # One extra batch read for all 100 after-balances, never per row.
    assert sum(s.lstrip().upper().startswith(('SELECT', 'WITH')) for s in statements) == 5


def test_filtered_history_preserves_exact_legacy_split_postings(ledger):
    conn, (outside, _), client = ledger
    repo = SqliteAccountRepository(conn)
    parent = repo.create(Account(name="그룹", type=AccountType.ASSET, is_placeholder=True)).id
    child = repo.create(Account(name="하위", type=AccountType.ASSET, parent_id=parent)).id
    bank = repo.create(Account(name="그룹 통장", type=AccountType.ASSET, parent_id=parent)).id
    limit = 2**53 - 1
    for legs in [[(bank, limit), (outside, -limit)],
                 [(bank, limit + 2), (child, -(limit + 2))],
                 [(bank, -limit - 2), (child, limit), (outside, 2)]]:
        SqliteTransactionRepository(conn).save(Transaction(date=dt.date(2026, 9, 15), scenario_id=1,
            postings=[Posting(account_id=aid, amount=Money(amount=n)) for aid, n in legs]))
    filtered = query(client, account_id=parent).json()["items"]
    raw = query(client).json()["items"]
    assert client.get("/api/transactions").json() == raw[::-1]
    exact = client.get("/api/transactions?exact_minor=true").json()
    assert [item["postings"] for item in exact] == [row["postings"] for row in filtered[::-1]]
    for row, original in zip(filtered, raw, strict=True):
        for p, old in zip(row["postings"], original["postings"], strict=True):
            assert p["amount"] == old["amount"]
            assert "exact_minor" not in old
            if abs(old["amount"]["amount"]) > limit:
                assert p["exact_minor"] == str(old["amount"]["amount"])
            else:
                assert "exact_minor" not in p
    assert [sum(int(p.get("exact_minor", p["amount"]["amount"])) for p in row["postings"]
                if p["account_id"] in (bank, child)) for row in filtered] == [-2, 0, limit]
