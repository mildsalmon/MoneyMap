"""B01–B18: real ledger selection, compatibility, provenance and memo."""
import datetime as dt
import sqlite3
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, init_db, SqliteAccountRepository, SqliteTransactionRepository
from moneymap.adapters.sqlite.transaction_input import SqliteTransactionInputQueries
from moneymap.adapters.sqlite.transactions import ScenarioTransactionWriter
from moneymap.app_services.transaction_input import last_pair, recent_inputs
from moneymap.api import create_app
from moneymap.domain import Account, AccountType, Money, Posting, Transaction
from moneymap.domain.errors import DomainValidationError
from moneymap.domain.transaction_input import normalize_item_key, CandidateLeg, PairCandidate, validate_latest_pair


@pytest.fixture
def ledger(tmp_path):
    conn = connect(str(tmp_path / "input.db"))
    init_db(conn)
    repo = SqliteAccountRepository(conn)
    ids = [repo.create(Account(name=n, type=t)).id for n, t in [
        ("식비", AccountType.EXPENSE), ("카드", AccountType.LIABILITY), ("현금", AccountType.ASSET),
    ]]
    yield conn, ids
    conn.close()


def transaction(ids, item="점심", day="2026-09-05", memo="", **kwargs):
    return Transaction(scenario_id=kwargs.pop("scenario_id", 1), date=dt.date.fromisoformat(day),
                       description=item, memo=memo, postings=[
                           Posting(account_id=ids[0], amount=Money(amount=9000)),
                           Posting(account_id=ids[1], amount=Money(amount=-9000)),
                       ], **kwargs)


@pytest.mark.parametrize("item,expected", [
    (" 점심 \n", "점심"), (unicodedata.normalize("NFD", "점심"), "점심"),
    ("", ""), (" \t", ""), ("\ufeff점심\u0085", "점심"), ("\x1c점심\x1f", "점심"), ("A  b?", "A  b?"), ("a  b?", "a  b?"),
])
def test_exact_key(item, expected):
    assert normalize_item_key(item) == expected


def test_blank_never_queries():
    class NeverQuery:
        def last_candidate(self, key):
            pytest.fail("blank item must not query")
    assert last_pair(NeverQuery(), " \n").status == "none"


def test_latest_save_not_date_or_recent_eight_and_memo_roundtrip(ledger):
    conn, ids = ledger
    repo = SqliteTransactionRepository(conn)
    q = SqliteTransactionInputQueries(conn)
    assert last_pair(q, "점심").status == "none"
    first = repo.save(transaction(ids, day="2030-01-01"))
    for i in range(12):
        repo.save(transaction(ids, item=f"다른 {i}"))
    assert last_pair(q, "점심").source_transaction_id == first.id
    memo = "팀원과 점심\n<script>문자 그대로</script> 🥗"
    latest = repo.save(transaction([ids[0], ids[2]], item=" 점심 ", day="2020-01-01", memo=memo))
    result = last_pair(q, unicodedata.normalize("NFD", "점심"))
    assert result.status == "matched"
    assert (result.source_transaction_id, result.credit_account_id) == (latest.id, ids[2])
    assert "memo" not in result.model_dump() and "amount" not in result.model_dump()
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    reopened = connect(path)
    try:
        stored = next(t for t in SqliteTransactionRepository(reopened).find_by_scenario(1) if t.id == latest.id)
        assert stored.memo == memo and stored.description == " 점심 "
    finally:
        reopened.close()
    assert repo.delete(latest.id, scenario_id=1)
    assert last_pair(q, "점심").source_transaction_id == first.id
    assert repo.delete(first.id, scenario_id=1)
    assert last_pair(q, "점심").status == "none"


@pytest.mark.parametrize("kind", ["split", "same"])
def test_invalid_latest_never_falls_back(ledger, kind):
    conn, ids = ledger
    repo = SqliteTransactionRepository(conn)
    repo.save(transaction(ids))
    legs = [(ids[0], 5000), (ids[2], 4000), (ids[1], -9000)] if kind == "split" else [(ids[0], 9000), (ids[0], -9000)]
    latest = repo.save(transaction(ids).model_copy(update={"postings": [Posting(account_id=i, amount=Money(amount=v)) for i, v in legs]}))
    result = last_pair(SqliteTransactionInputQueries(conn), "점심")
    assert result.status == "unavailable" and result.source_transaction_id == latest.id
    assert result.unavailable_reason == ("split" if kind == "split" else "invalid_pair")
    assert result.debit_account_id is None


@pytest.mark.parametrize("change", ["archived", "placeholder", "child", "system", "missing"])
def test_latest_account_eligibility_is_current(ledger, change):
    conn, ids = ledger
    repo = SqliteTransactionRepository(conn)
    repo.save(transaction([ids[0], ids[2]]))
    latest = repo.save(transaction(ids))
    with conn:
        if change == "child":
            conn.execute("INSERT INTO accounts(name,type,parent_id,archived,position) VALUES('숨은 자식','liability',?,1,1)", (ids[1],))
        elif change == "missing":
            # Legacy corrupted read fixture, never a permitted normal write.
            conn.execute("PRAGMA foreign_keys=OFF")
            conn.execute("DELETE FROM accounts WHERE id=?", (ids[1],))
        else:
            column = {"archived": "archived", "placeholder": "is_placeholder", "system": "is_system"}[change]
            conn.execute(f"UPDATE accounts SET {column}=1 WHERE id=?", (ids[1],))
    result = last_pair(SqliteTransactionInputQueries(conn), "점심")
    assert (result.status, result.unavailable_reason) == ("unavailable", "account_unavailable")
    assert result.source_transaction_id == latest.id and result.credit_account_id is None


def test_rename_keeps_identity_and_legacy_confirmation_does_not_write(ledger):
    conn, ids = ledger
    repo = SqliteTransactionRepository(conn)
    saved = repo.save(transaction(ids))
    with conn:
        conn.execute("UPDATE accounts SET name='새 카드 이름' WHERE id=?", (ids[1],))
        conn.execute("UPDATE transactions SET entry_origin='legacy_unknown' WHERE id=?", (saved.id,))
    q = SqliteTransactionInputQueries(conn)
    before = conn.total_changes
    for _ in range(2):
        result = last_pair(q, "점심")
        assert result.status == "legacy_confirmation_required" and result.credit_account_id == ids[1]
    assert conn.total_changes == before
    repo.save(transaction(ids))
    assert last_pair(q, "점심").status == "matched"


@pytest.mark.parametrize("kind", ["archived", "system", "group"])
def test_save_rechecks_current_accounts_without_partial_write(ledger, kind):
    conn, ids = ledger
    with conn:
        conn.execute(f"UPDATE accounts SET {dict(archived='archived',system='is_system',group='is_placeholder')[kind]}=1 WHERE id=?", (ids[1],))
    with pytest.raises(DomainValidationError) as error:
        SqliteTransactionRepository(conn).save(transaction(ids, memo="남아서는 안 됨"))
    assert error.value.context["account_id"] == ids[1]
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 0
    assert not conn.in_transaction


@pytest.mark.parametrize("stage", ["transaction", "posting", "confirmation"])
def test_failure_rolls_back_memo_and_metadata(ledger, stage):
    conn, ids = ledger
    def deny(action, table, column, *_):
        reject = (stage == "transaction" and action == sqlite3.SQLITE_INSERT and table == "transactions"
                  or stage == "posting" and action == sqlite3.SQLITE_INSERT and table == "postings"
                  or stage == "confirmation" and action == sqlite3.SQLITE_UPDATE and table == "transactions" and column == "posted")
        return sqlite3.SQLITE_DENY if reject else sqlite3.SQLITE_OK
    conn.set_authorizer(deny)
    with pytest.raises(sqlite3.DatabaseError):
        SqliteTransactionRepository(conn).save(transaction(ids, memo="원자적 메모"))
    conn.set_authorizer(None)
    assert not conn.in_transaction
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM postings").fetchone()[0] == 0


def test_origins_exclude_opening_rule_after_deletion_and_scenario(ledger):
    conn, ids = ledger
    repo = SqliteTransactionRepository(conn)
    saved = repo.save(transaction(ids))
    opening = conn.execute("SELECT id FROM accounts WHERE is_system=1").fetchone()[0]
    system = repo.save(transaction([ids[2], opening]))
    with conn:
        rid = conn.execute("INSERT INTO recurring_rules(scenario_id,from_account_id,to_account_id,amount,schedule,start_date) VALUES(1,?,?,9000,'monthly:1','2026-09-01')", (ids[1], ids[0])).lastrowid
    generated = repo.save(transaction(ids, source_rule_id=rid))
    with conn:
        conn.execute("UPDATE transactions SET source_rule_id=NULL WHERE source_rule_id=?", (rid,))
        conn.execute("DELETE FROM recurring_rules WHERE id=?", (rid,))
        sid = conn.execute("INSERT INTO scenarios(name,base_scenario_id,fork_date) VALUES('가설',1,'2026-09-01')").lastrowid
        scenario = ScenarioTransactionWriter(conn).save(transaction(ids, scenario_id=sid, memo="가설 메모"))
        assert conn.in_transaction
    origins = {r["id"]: r["entry_origin"] for r in conn.execute("SELECT id,entry_origin FROM transactions")}
    assert origins == {saved.id: "user", system.id: "system", generated.id: "rule", scenario.id: "user"}
    q = SqliteTransactionInputQueries(conn)
    assert last_pair(q, "점심").source_transaction_id == saved.id
    assert [r.id for r in recent_inputs(q, 20)] == [saved.id]
    assert repo.find_by_scenario(sid)[0].memo == "가설 메모"


@pytest.mark.parametrize("limit", [1, 5, 20])
def test_recent_limits_and_no_memo_payload(ledger, limit):
    conn, ids = ledger
    repo = SqliteTransactionRepository(conn)
    saved = [repo.save(transaction(ids, item=f"입력{i}", memo="메모" * 1000)) for i in range(22)]
    rows = recent_inputs(SqliteTransactionInputQueries(conn), limit)
    assert [r.id for r in rows] == [r.id for r in reversed(saved[-limit:])]
    assert all(r.amount == 9000 and r.posting_count == 2 and "memo" not in r.model_dump() for r in rows)


def test_candidate_and_account_read_share_snapshot(ledger):
    conn, ids = ledger
    saved = SqliteTransactionRepository(conn).save(transaction(ids))
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    ready, updated = Event(), Event()
    class BetweenStatements:
        def execute(self, sql, params):
            if sql.startswith("SELECT p.account_id"):
                ready.set()
                assert updated.wait(5)
            return conn.execute(sql, params)
    def archive():
        assert ready.wait(5)
        writer = connect(path)
        try:
            with writer:
                writer.execute("UPDATE accounts SET archived=1 WHERE id=?", (ids[1],))
        finally:
            writer.close()
            updated.set()
    conn.execute("BEGIN")
    with ThreadPoolExecutor(max_workers=1) as pool:
        task = pool.submit(archive)
        result = last_pair(SqliteTransactionInputQueries(BetweenStatements()), "점심")
        task.result(timeout=5)
    assert result.status == "matched" and result.source_transaction_id == saved.id
    conn.rollback()
    assert last_pair(SqliteTransactionInputQueries(conn), "점심").status == "unavailable"


def test_pure_pair_shape_and_app_port():
    a = CandidateLeg(1, 100, "KRW", True)
    for b in [CandidateLeg(2, -99, "KRW", True), CandidateLeg(2, -100, "USD", True), CandidateLeg(2, 0, "KRW", True)]:
        assert validate_latest_pair("x", PairCandidate(1, "user", (a, b))).unavailable_reason == "invalid_pair"
    class Query:
        def last_candidate(self, key):
            assert key == "점심"
            return PairCandidate(12, "user", (a, CandidateLeg(2, -100, "KRW", True)))
    assert last_pair(Query(), " 점심 ").status == "matched"


def test_http_contract_origin_injection_and_memo(tmp_path):
    with TestClient(create_app(str(tmp_path / "api.db"))) as client:
        ids = [client.post("/api/accounts", json={"name": n, "type": t}).json()["id"] for n, t in [("음식", "expense"), ("지갑", "asset")]]
        item = ' 점심&?" 한글 '
        payload = {"date": "2026-09-05", "description": item, "memo": "한 줄\n다음 줄", "postings": [{"account_id": ids[0], "amount": 100}, {"account_id": ids[1], "amount": -100}]}
        for injected in ["entry_origin", "item_key", "scenario_id"]:
            assert client.post("/api/transactions", json={**payload, injected: "rule"}).status_code == 422
        response = client.post("/api/transactions", json=payload)
        assert response.status_code == 201, response.text
        assert response.json()["memo"] == payload["memo"]
        result = client.get("/api/transaction-input/last-pair", params={"item": item, "scenario_id": 2})
        assert result.status_code == 200 and result.json()["status"] == "matched"
        assert result.json()["item_key"] == item.strip()
        assert client.get("/api/transaction-input/last-pair").status_code == 422
        for limit in [0, 21, "NaN"]:
            assert client.get("/api/transaction-input/recent", params={"limit": limit}).status_code == 422
        assert client.get("/api/transactions").json()[0]["memo"] == payload["memo"]
        assert client.get("/api/transaction-input/recent").json()[0]["id"] == response.json()["id"]
        assert client.post("/api/transactions", json={k: v for k, v in payload.items() if k != "memo"}).json()["memo"] == ""


def test_large_excluded_history_uses_partial_indexes_and_bounded_queries(ledger):
    conn, ids = ledger
    eligible = [SqliteTransactionRepository(conn).save(transaction(ids)) for _ in range(5)]
    saved = eligible[-1]
    # A large rule-only tail must not require scanning through ineligible rows.
    with conn:
        conn.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200000) INSERT INTO transactions(scenario_id,date,description,item_key,entry_origin,posted) SELECT 1,'2026-09-01','점심','점심','rule',0 FROM n")
        # No postings needed for excluded rows. Historical posted flags are seeded
        # before read tests through a temporary trigger suspension.
        trigger = conn.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='transactions' AND sql LIKE '%NEW.posted%' AND sql LIKE '%SUM%'").fetchone()
        assert trigger is not None
        conn.execute(f'DROP TRIGGER "{trigger[0]}"')
        conn.execute("UPDATE transactions SET posted=1 WHERE entry_origin='rule'")
        conn.execute(trigger[1])
    statements = []
    conn.set_trace_callback(statements.append)
    q = SqliteTransactionInputQueries(conn)
    assert last_pair(q,'점심').source_transaction_id == saved.id
    last_statements = statements[:]
    statements.clear()
    assert [r.id for r in recent_inputs(q,5)] == [r.id for r in reversed(eligible)]
    recent_statements = statements[:]
    conn.set_trace_callback(None)
    assert len(last_statements) <= 4 and len(recent_statements) <= 3
    for sql, index in [(last_statements[0],'idx_txn_input_item'), (recent_statements[0],'idx_txn_input_recent')]:
        plan = ' '.join(r[3] for r in conn.execute('EXPLAIN QUERY PLAN '+sql))
        assert index in plan, plan
    for sql in recent_statements:
        plan = ' '.join(r[3] for r in conn.execute('EXPLAIN QUERY PLAN '+sql))
        assert 'USE TEMP B-TREE' not in plan, plan
    # Latest split uses at most three legs to reject even very large splits.
    with conn:
        split = conn.execute("INSERT INTO transactions(scenario_id,date,description,item_key,entry_origin) VALUES(1,'2026-09-01','점심','점심','user')").lastrowid
        conn.executemany('INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)', [(split,ids[i%2],1 if i%2==0 else -1) for i in range(20000)])
        conn.execute('UPDATE transactions SET posted=1 WHERE id=?',(split,))
    assert len(q.last_candidate('점심').legs) == 3
    assert last_pair(q,'점심').unavailable_reason == 'split'
    recent = q.recent(5)
    assert recent[0].posting_count == 20000 and recent[0].amount == 10000
