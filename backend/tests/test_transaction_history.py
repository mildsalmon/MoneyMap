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
