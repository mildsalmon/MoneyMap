"""Hand-computed reporting goldens, boundaries and whole-transaction exclusion."""
import datetime as dt
import pytest
from fastapi.testclient import TestClient
from moneymap.api import create_app
from moneymap.adapters.sqlite import connect, SqliteAccountRepository, SqliteTransactionRepository
from moneymap.domain import Account, AccountType, Money, Posting, Transaction
from moneymap.adapters.sqlite.statistics import read_statistics


@pytest.fixture
def client(tmp_path, monkeypatch):
    import moneymap.routers.reporting as reporting
    monkeypatch.setattr(reporting, "now", lambda: dt.datetime(2026, 10, 25, 9))
    with TestClient(create_app(str(tmp_path / "statistics.db"))) as c:
        yield c


def account(client, name, kind, **extra):
    r = client.post('/api/accounts', json={"name": name, "type": kind, **extra})
    assert r.status_code == 201, r.text
    return r.json()['id']


def post(client, day, *entries):
    r = client.post('/api/transactions', json={"date": day, "postings": [
        {"account_id": aid, "amount": amount} for aid, amount in entries]})
    assert r.status_code == 201, r.text
    return r.json()['id']


def query(client, start='2026-01-15', end='2026-03-10'):
    r = client.get('/api/statistics', params={"start": start, "end": end})
    assert r.status_code == 200, r.text
    return r.json()


def test_flows_stocks_partial_months_refunds_transfers_card_and_equity(client):
    bank = account(client, '은행', 'asset')
    saving = account(client, '저축', 'asset')
    salary = account(client, '급여', 'income')
    cost = account(client, '비용', 'expense')
    card = account(client, '카드', 'liability')
    assert client.post(f'/api/accounts/{bank}/opening-balance', json={"date": '2026-01-01', "amount": 1000, "state": "positive"}).status_code == 201
    post(client, '2026-01-10', (bank, 200), (salary, -200))  # Before start: stock only.
    post(client, '2026-01-15', (bank, 500), (salary, -500))
    post(client, '2026-01-16', (cost, 150), (card, -150))
    post(client, '2026-01-17', (bank, -50), (card, 50))  # Principal, not another expense.
    post(client, '2026-01-18', (bank, 20), (cost, -20))
    post(client, '2026-01-19', (saving, 100), (bank, -100))
    post(client, '2026-03-10', (bank, 100), (salary, -80), (cost, -20))
    post(client, '2026-03-11', (bank, 9000), (salary, -9000))  # After end.
    data = query(client)
    assert data['summary'] == {"income": 580, "expense": 110, "net_income": 470,
        "opening_net_worth": 1200, "net_worth": 1670, "net_worth_change": 470,
        "assets": 1770, "liabilities": 100, "capital_change": 0, "reconciliation_difference": 0}
    assert data['transaction_count'] == 6
    assert [(r['month'], r['through'], r['income'], r['expense'], r['net_worth']) for r in data['monthly']] == [
        ('2026-01', '2026-01-31', 500, 130, 1570), ('2026-02', '2026-02-28', 0, 0, 1570),
        ('2026-03', '2026-03-10', 80, -20, 1670)]
    assert sum(r['net_income'] + r['capital_change'] for r in data['monthly']) == 470
    assert data['monthly'][-1]['net_worth'] == data['summary']['net_worth']
    opening = query(client, '2026-01-01', '2026-01-01')
    assert opening['summary']['income'] == 0
    assert opening['summary']['capital_change'] == opening['summary']['net_worth_change'] == 1000
    assert opening['monthly'][0]['capital_change'] == 1000


def test_overdraft_switches_reporting_bucket_and_archived_activity_is_preserved(client):
    group = account(client, '자산 그룹', 'asset', is_placeholder=True)
    bank = account(client, '마이너스', 'asset', parent_id=group, is_overdraft=True)
    income = account(client, '수익', 'income')
    expense = account(client, '비용', 'expense')
    post(client, '2026-01-01', (bank, -500), (expense, 500))
    before = query(client, '2026-01-01', '2026-01-01')
    assert before['summary']['assets'] == 0 and before['summary']['liabilities'] == 500
    assert next(r for r in before['balances'] if r['account_id'] == bank)['reporting_type'] == 'liability'
    post(client, '2026-02-01', (bank, 800), (income, -800))
    assert client.post(f'/api/accounts/{bank}/archive').status_code == 200
    after = query(client)
    assert after['summary']['assets'] == after['summary']['net_worth'] == 300
    assert after['summary']['liabilities'] == 0
    assert next(r for r in after['balances'] if r['account_id'] == bank)['reporting_type'] == 'asset'
    meta = next(a for a in after['accounts'] if a['id'] == bank)
    assert meta['archived'] and meta['parent_id'] == group


def test_currency_mismatch_excludes_whole_transaction_in_every_aggregate(client):
    bank = account(client, 'KRW bank', 'asset')
    conn = connect(client.app.state.db_path)
    foreign = SqliteAccountRepository(conn).create(Account(name='foreign account', type=AccountType.ASSET, currency='USD')).id
    conn.close()
    income = account(client, 'income', 'income')
    post(client, '2025-12-31', (foreign, 200), (income, -200))
    post(client, '2026-01-20', (bank, 50), (foreign, 50), (income, -100))
    post(client, '2026-01-21', (bank, 70), (income, -70))
    body = query(client)
    assert body['excluded_transaction_count'] == 2  # Includes opening-stock exclusions.
    assert body['transaction_count'] == 1
    assert body['summary']['income'] == body['summary']['net_worth'] == 70
    assert body['summary']['opening_net_worth'] == body['summary']['reconciliation_difference'] == 0
    assert sum(r['income'] for r in body['monthly']) == 70


def test_empty_period_and_leap_month_carry_opening_stock_without_inventing_flows(client):
    bank = account(client, '은행', 'asset')
    income = account(client, 'income', 'income')
    post(client, '2023-12-31', (bank, 20), (income, -20))
    body = query(client, '2024-02-15', '2024-03-01')
    assert body['transaction_count'] == 0
    assert body['summary']['income'] == body['summary']['expense'] == 0
    assert [(r['through'], r['net_worth']) for r in body['monthly']] == [('2024-02-29', 20), ('2024-03-01', 20)]
    minimum = query(client, '0001-01-01', '0001-01-01')
    assert minimum['monthly'][0]['net_worth'] == 0


@pytest.mark.parametrize('suffix', [
    '', '?start=2026-01-01', '?start=bad&end=2026-01-02', '?start=2026-02-30&end=2026-03-01',
    '?start=2026-02-02&end=2026-02-01', '?start=2026-01-01&end=2026-10-26',
    '?start=2026-01-01&start=2026-01-02&end=2026-02-01',
    '?start=2026-01-01&end=2026-02-01&scenario_id=2',
    '?start=2000-01-01&end=2026-01-01',
])
def test_invalid_or_ambiguous_query_is_rejected(client, suffix):
    assert client.get('/api/statistics' + suffix).status_code == 422


@pytest.mark.parametrize("account_count", [0, 30])
def test_exact_inclusive_range_limit_and_fixed_select_count(client, account_count):
    for i in range(account_count):
        account(client, f"계정-{i}", "asset")
    end = dt.date(2026, 10, 25)
    assert query(client, (end - dt.timedelta(days=3659)).isoformat(), end.isoformat())
    assert client.get('/api/statistics', params={'start': (end - dt.timedelta(days=3660)).isoformat(), 'end': end.isoformat()}).status_code == 422
    conn = connect(client.app.state.db_path)
    statements = []
    conn.set_trace_callback(statements.append)
    with pytest.raises(RuntimeError):
        read_statistics(conn, end, end)
    conn.execute('BEGIN')
    try:
        read_statistics(conn, dt.date(2026, 1, 1), end)
    finally:
        conn.rollback(); conn.close()
    assert sum(s.lstrip().upper().startswith(('SELECT', 'WITH')) for s in statements) == 4
    assert not any(s.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for s in statements)


def test_non_krw_postings_are_excluded_even_when_accounts_are_krw(client):
    bank = account(client, 'bank', 'asset')
    income = account(client, 'income', 'income')
    conn = connect(client.app.state.db_path)
    SqliteTransactionRepository(conn).save(Transaction(scenario_id=1, date=dt.date(2026, 1, 20),
        postings=[Posting(account_id=bank, amount=Money(amount=100, currency='USD')),
                  Posting(account_id=income, amount=Money(amount=-100, currency='USD'))]))
    conn.close()
    body = query(client)
    assert body['excluded_transaction_count'] == 1
    assert body['transaction_count'] == body['summary']['net_worth'] == 0


def test_aggregate_beyond_javascript_safe_integer_is_rejected_instead_of_rounded(client):
    bank = account(client, 'bank', 'asset')
    income = account(client, 'income', 'income')
    for day in ['2026-01-01', '2026-01-02']:
        post(client, day, (bank, 9_007_199_254_740_991), (income, -9_007_199_254_740_991))
    response = client.get('/api/statistics?start=2026-01-01&end=2026-01-02')
    assert response.status_code == 400
    assert response.json()['detail']['code'] == 'statistics_amount_out_of_range'


def test_forecast_scenario_and_unposted_actual_are_not_actual_statistics(client):
    bank = account(client, 'bank', 'asset')
    income = account(client, 'income', 'income')
    scenario = client.post('/api/scenarios', json={'name': '통계 제외 가정', 'fork_date': '2026-01-01'})
    assert scenario.status_code == 201, scenario.text
    sid = scenario.json()['scenario']['id']
    conn = connect(client.app.state.db_path)
    with conn:
        for owner, posted in [(sid, True), (1, False)]:
            tid = conn.execute("INSERT INTO transactions(scenario_id,date,description) VALUES(?,?,?)", (owner, '2026-01-20', '예정/미게시')).lastrowid
            conn.executemany("INSERT INTO postings(txn_id,account_id,amount,currency) VALUES(?,?,?,'KRW')", [(tid, bank, 1000), (tid, income, -1000)])
            if posted:
                conn.execute('UPDATE transactions SET posted=1 WHERE id=?', (tid,))
    conn.close()
    body = query(client)
    assert body['transaction_count'] == body['excluded_transaction_count'] == 0
    assert body['summary']['income'] == body['summary']['net_worth'] == 0


def test_sqlite_intermediate_sum_overflow_returns_domain_error(client):
    bank = account(client, 'bank', 'asset')
    income = account(client, 'income', 'income')
    conn = connect(client.app.state.db_path)
    with conn:
        for sign in [1, -1]:
            for _ in range(1025):
                tid = conn.execute("INSERT INTO transactions(scenario_id,date,description) VALUES(1,'2026-01-01','overflow')").lastrowid
                amount = sign * 9_007_199_254_740_991
                conn.executemany("INSERT INTO postings(txn_id,account_id,amount,currency) VALUES(?,?,?,'KRW')", [(tid, bank, amount), (tid, income, -amount)])
                conn.execute('UPDATE transactions SET posted=1 WHERE id=?', (tid,))
    conn.close()
    response = client.get('/api/statistics?start=2026-01-01&end=2026-01-01')
    assert response.status_code == 400
    assert response.json()['detail']['code'] == 'statistics_amount_out_of_range'
