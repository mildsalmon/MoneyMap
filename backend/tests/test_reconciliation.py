from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest

from moneymap.adapters.sqlite import connect
from test_api import client, make_account, opening_account_id
from test_balance_history import insert


PREVIEW = "/api/reconciliation/preview"
CONFIRM = "/api/reconciliation/confirm"
CLOSE = "2026-03-31"


@pytest.fixture
def ledger(client):
    ids = [make_account(client, "통장", "asset"), make_account(client, "비용", "expense"),
           make_account(client, "카드", "liability")]
    conn = connect(client.app.state.db_path)
    with conn:
        insert(conn, ids, 95000, CLOSE)
        insert(conn, [ids[2], ids[1]], -95000, CLOSE)
        insert(conn, ids, 25, CLOSE, "USD")
    yield conn, ids
    conn.close()


def statement(account, **changes):
    return dict(account_id=account, currency="KRW", closing_date=CLOSE, statement_minor="100000") | changes


def preview(client, s):
    r = client.post(PREVIEW, json=s)
    assert r.status_code == 200, r.text
    return r.json()


def command(s, comparison, other):
    return dict(statement=s, preview_version=comparison["preview_version"], request_id=str(uuid4()),
                counterpart_id=other, reason="  누락분  ")


@pytest.mark.parametrize("index,sign", [(0, 1), (2, -1)])
def test_cutoff_signs_receipt_and_confirm(client, ledger, index, sign):
    conn, ids = ledger
    aid, other = ids[index], ids[1]
    s = statement(aid)
    p = preview(client, s)
    assert (p["ledger_minor"], p["difference_minor"], p["posting_minor"]) == ("95000", "5000", str(5000 * sign))
    with conn:
        insert(conn, [aid, other], 900, "2026-04-01")
        insert(conn, [aid, other], 100, CLOSE, "USD")
        scenario = conn.execute("INSERT INTO scenarios(name) VALUES('합성')").lastrowid
        insert(conn, [aid, other], 2300, CLOSE, scenario=scenario)
    assert preview(client, s) == p
    cmd = command(s, p, other)
    r = client.post(CONFIRM, json=cmd)
    assert r.status_code == 200, r.text
    tid = r.json()["transaction_id"]
    t = conn.execute("SELECT date,posted,memo FROM transactions WHERE id=?", (tid,)).fetchone()
    assert tuple(t) == (CLOSE, 1, "누락분")
    assert [tuple(x) for x in conn.execute("SELECT account_id,amount,currency FROM postings WHERE txn_id=? ORDER BY id", (tid,))] == [
        (aid, sign*5000, "KRW"), (other, -sign*5000, "KRW")]
    assert preview(client, s)["difference_minor"] == "0"
    assert client.post(CONFIRM, json=cmd).json() == r.json()
    assert client.post(CONFIRM, json=cmd | {"reason": "다른 요청"}).status_code == 409
    assert conn.execute("SELECT COUNT(*) FROM reconciliation_requests").fetchone()[0] == 1
    assert client.delete(f"/api/transactions/{tid}").is_success
    assert client.post(CONFIRM, json=cmd).json() == r.json()
    assert preview(client, s)["difference_minor"] == "5000"


def test_same_balance_edit_stales_preview_and_rollback_allows_retry(client, ledger):
    conn, ids = ledger
    s = statement(ids[0])
    first = preview(client, s)
    cmd = command(s, first, ids[1])
    with conn:
        conn.execute("UPDATE transactions SET memo='내역 정정' WHERE id=(SELECT MIN(id) FROM transactions)")
    r = client.post(CONFIRM, json=cmd)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "stale_preview"
    second = preview(client, s)
    assert second["ledger_minor"] == first["ledger_minor"]
    cmd = command(s, second, ids[1])
    before = conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    conn.execute("""CREATE TRIGGER receipt_failure BEFORE INSERT ON reconciliation_requests BEGIN
                 SELECT RAISE(ABORT, 'synthetic failure'); END""")
    assert not client.post(CONFIRM, json=cmd).is_success
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == before
    assert preview(client, s) == second
    conn.execute("DROP TRIGGER receipt_failure")
    assert client.post(CONFIRM, json=cmd).is_success


@pytest.mark.parametrize("same_request", [True, False])
def test_concurrent_confirm_posts_once(client, ledger, same_request):
    conn, ids = ledger
    s = statement(ids[0], currency="USD", statement_minor="-1001")
    p = preview(client, s)
    assert p["ledger_minor"] == "25"
    first = command(s, p, ids[1])
    second = first if same_request else command(s, p, ids[1])
    barrier = Barrier(2)

    def submit(cmd):
        barrier.wait(timeout=10)
        return client.post(CONFIRM, json=cmd)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(submit, [first, second]))
    assert sorted(r.status_code for r in results) == ([200, 200] if same_request else [200, 409])
    if same_request:
        assert results[0].json() == results[1].json()
    assert preview(client, s)["difference_minor"] == "0"
    assert conn.execute("SELECT COUNT(*) FROM reconciliation_requests").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM postings WHERE amount=-1026 AND currency='USD'").fetchone()[0] == 1


@pytest.mark.parametrize("case", ["missing", "expense", "currency", "fraction", "invalid_date", "out_of_range",
                                 "blank", "same", "system", "archived", "group", "matched", "unrepresentable"])
def test_invalid_requests_leave_ledger_alone(client, ledger, case):
    conn, ids = ledger
    s = statement(ids[0])
    cmd = command(s, preview(client, s), ids[1])
    preview_changes = dict(missing={"account_id": 9999}, expense={"account_id": ids[1]},
                           currency={"currency": "BAD"}, fraction={"statement_minor": "3.4"},
                           invalid_date={"closing_date": "2026-02-30"}, out_of_range={"statement_minor": str(2**65)})
    if case in preview_changes:
        r = client.post(PREVIEW, json=s | preview_changes[case])
    else:
        if case == "blank": cmd["reason"] = " "
        if case == "same": cmd["counterpart_id"] = ids[0]
        if case == "system": cmd["counterpart_id"] = opening_account_id(client)
        if case == "archived": client.post(f"/api/accounts/{ids[1]}/archive").raise_for_status()
        if case == "group":
            group = client.post("/api/accounts", json=dict(name="그룹", type="expense", is_placeholder=True))
            cmd["counterpart_id"] = group.json()["id"]
        if case in {"matched", "unrepresentable"}:
            s = statement(ids[0], statement_minor="95000" if case == "matched" else str(-(2**63)))
            cmd = command(s, preview(client, s), ids[1])
        r = client.post(CONFIRM, json=cmd)
    assert 400 <= r.status_code < 500, r.text
    assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 3
    assert conn.execute("SELECT COUNT(*) FROM reconciliation_requests").fetchone()[0] == 0


def test_exact_minor_units_above_javascript_safe_integer(client, ledger):
    conn, ids = ledger
    raw = 2**53 + 1
    with conn:
        insert(conn, ids, raw, CLOSE, "JPY")
    s = statement(ids[0], currency="JPY", statement_minor=str(raw - 1))
    p = preview(client, s)
    assert p["ledger_minor"] == str(raw)
    assert p["difference_minor"] == "-1"
    assert client.post(CONFIRM, json=command(s, p, ids[1])).is_success
    assert preview(client, s)["ledger_minor"] == str(raw - 1)


def test_foreign_card_adjustment_keeps_native_balances_and_recent_amount(client, ledger):
    conn, ids = ledger
    card, other = ids[2], ids[1]
    with conn:
        insert(conn, [card, other], -5300, CLOSE)
    s = statement(card, currency="USD", statement_minor="1025")
    txn = client.post(CONFIRM, json=command(s, preview(client, s), other)).json()["transaction_id"]
    balances = client.get("/api/balances", params={"at": CLOSE}).json()["accounts"]
    row = next(r for r in balances if r["account_id"] == card)
    assert row["balance"] == -100300
    assert row["by_currency"] == {"KRW": "-100300", "USD": "-1025"}
    recent = client.get("/api/transaction-input/recent").json()[0]
    assert (recent["id"], recent["currency"], recent["exact_minor"]) == (txn, "USD", "1025")
    assert preview(client, s)["difference_minor"] == "0"
