"""SQLite 어댑터 통합 테스트 — 실제 SQLite(인메모리)로 검증."""

import datetime
import sqlite3

import pytest

from moneymap.adapters.sqlite import (
    SqliteAccountRepository,
    SqliteLedgerQueries,
    SqliteRecurringRuleRepository,
    SqliteScenarioRepository,
    SqliteTransactionRepository,
    connect,
    init_db,
)
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Account,
    AccountType,
    Money,
    Posting,
    RecurringRule,
    Scenario,
    Schedule,
    Transaction,
)
from moneymap.domain.account import OPENING_BALANCE_ACCOUNT_NAME

D = datetime.date


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = connect(":memory:")
    init_db(c)
    return c


@pytest.fixture
def accounts(conn) -> dict[str, Account]:
    repo = SqliteAccountRepository(conn)
    return {
        "toss": repo.save(Account(name="Toss", type=AccountType.ASSET)),
        "food": repo.save(Account(name="식비", type=AccountType.EXPENSE)),
        "card": repo.save(Account(name="현대카드", type=AccountType.LIABILITY)),
        "opening": repo.find_by_name(OPENING_BALANCE_ACCOUNT_NAME),
    }


def expense_txn(scenario_id: int, date: D, food_id: int, card_id: int, amount: int) -> Transaction:
    return Transaction(
        scenario_id=scenario_id,
        date=date,
        description="지출",
        postings=[
            Posting(account_id=food_id, amount=Money(amount=amount)),
            Posting(account_id=card_id, amount=Money(amount=-amount)),
        ],
    )


# ─── 시드 ───────────────────────────────────────────────

def test_seeds(conn):
    sc = SqliteScenarioRepository(conn).find_by_id(ACTUAL_SCENARIO_ID)
    assert sc is not None and sc.is_actual and sc.name == "actual"

    opening = SqliteAccountRepository(conn).find_by_name(OPENING_BALANCE_ACCOUNT_NAME)
    assert opening is not None and opening.type == AccountType.EQUITY


def test_init_db_idempotent(conn):
    init_db(conn)  # 두 번 불러도 시드 중복 없음
    rows = conn.execute(
        "SELECT COUNT(*) AS n FROM accounts WHERE name=?", (OPENING_BALANCE_ACCOUNT_NAME,)
    ).fetchone()
    assert rows["n"] == 1


# ─── 계정 ───────────────────────────────────────────────

def test_account_roundtrip(conn, accounts):
    repo = SqliteAccountRepository(conn)
    found = repo.find_by_id(accounts["toss"].id)
    assert found == accounts["toss"]
    assert len(repo.find_all()) == 4  # 시드 1 + 생성 3


# ─── 거래 저장 + 트리거 백스톱 ───────────────────────────

def test_transaction_roundtrip(conn, accounts):
    repo = SqliteTransactionRepository(conn)
    saved = repo.save(
        expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 5), accounts["food"].id, accounts["card"].id, 52_000)
    )
    assert saved.id is not None
    loaded = repo.find_by_scenario(ACTUAL_SCENARIO_ID)
    assert len(loaded) == 1
    assert loaded[0].postings == saved.postings


def test_trigger_rejects_unbalanced_raw_sql(conn, accounts):
    """도메인을 우회한 raw SQL도 트리거가 막는다 (이중 enforce의 존재 이유)."""
    conn.execute(
        "INSERT INTO transactions (id, scenario_id, date, posted) VALUES (100, ?, '2026-07-05', 0)",
        (ACTUAL_SCENARIO_ID,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (100, ?, 52000)",
        (accounts["food"].id,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (100, ?, -50000)",
        (accounts["card"].id,),
    )
    with pytest.raises(sqlite3.IntegrityError, match="차변=대변"):
        conn.execute("UPDATE transactions SET posted=1 WHERE id=100")
    conn.rollback()


def test_trigger_rejects_mixed_currency_raw_sql(conn, accounts):
    conn.execute(
        "INSERT INTO transactions (id, scenario_id, date, posted) VALUES (101, ?, '2026-07-05', 0)",
        (ACTUAL_SCENARIO_ID,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) VALUES (101, ?, 100, 'USD')",
        (accounts["food"].id,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) VALUES (101, ?, -100, 'KRW')",
        (accounts["card"].id,),
    )
    with pytest.raises(sqlite3.IntegrityError, match="단일 통화"):
        conn.execute("UPDATE transactions SET posted=1 WHERE id=101")
    conn.rollback()


def test_trigger_blocks_tampering_posted_txn(conn, accounts):
    repo = SqliteTransactionRepository(conn)
    saved = repo.save(
        expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 5), accounts["food"].id, accounts["card"].id, 10_000)
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE postings SET amount=999 WHERE txn_id=?", (saved.id,))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM postings WHERE txn_id=?", (saved.id,))


def test_unposted_transactions_invisible(conn, accounts):
    """posted=0(부분 쓰기)은 조회·잔액 어디에도 안 보인다."""
    conn.execute(
        "INSERT INTO transactions (id, scenario_id, date, posted) VALUES (102, ?, '2026-07-05', 0)",
        (ACTUAL_SCENARIO_ID,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (102, ?, 77000)",
        (accounts["food"].id,),
    )
    assert SqliteTransactionRepository(conn).find_by_scenario(ACTUAL_SCENARIO_ID) == []
    bal = SqliteLedgerQueries(conn).balance_at(
        accounts["food"].id, D(2026, 12, 31), ACTUAL_SCENARIO_ID
    )
    assert bal.amount == 0


# ─── 잔액 (fold 의미론, depth-1) ─────────────────────────

def test_balance_at_actual(conn, accounts):
    repo = SqliteTransactionRepository(conn)
    q = SqliteLedgerQueries(conn)
    food, card = accounts["food"].id, accounts["card"].id
    repo.save(expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 1), food, card, 10_000))
    repo.save(expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 10), food, card, 20_000))

    assert q.balance_at(food, D(2026, 7, 5), ACTUAL_SCENARIO_ID).amount == 10_000
    assert q.balance_at(food, D(2026, 7, 31), ACTUAL_SCENARIO_ID).amount == 30_000
    assert q.balance_at(card, D(2026, 7, 31), ACTUAL_SCENARIO_ID).amount == -30_000
    # 자산=부채+자본 검산: 전체 posting 합은 항상 0
    total = conn.execute(
        "SELECT COALESCE(SUM(p.amount),0) AS s FROM postings p"
        " JOIN transactions t ON t.id=p.txn_id WHERE t.posted=1"
    ).fetchone()["s"]
    assert total == 0


def test_balance_at_scenario_fork_boundary(conn, accounts):
    """fork 경계 (D2/D7-B 정밀 규칙):

    actual 쪽: date < fork 포함 + date = fork 인 '수동 입력' 포함,
               date = fork 인 '규칙 생성분' 제외 (시뮬레이션과 이중 계상 방지),
               date > fork 제외.
    시나리오 쪽: fork ≤ date ≤ T 포함.
    """
    txn_repo = SqliteTransactionRepository(conn)
    q = SqliteLedgerQueries(conn)
    food, card = accounts["food"].id, accounts["card"].id
    fork = D(2026, 7, 10)

    # fork 당일 규칙 생성분을 만들기 위한 규칙 (FK용)
    rule = SqliteRecurringRuleRepository(conn).save(
        RecurringRule(
            scenario_id=ACTUAL_SCENARIO_ID,
            description="월세",
            from_account_id=card,
            to_account_id=food,
            amount=Money(amount=777_777),
            schedule=Schedule(spec="monthly:10"),
            start_date=D(2026, 7, 1),
        )
    )

    txn_repo.save(expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 5), food, card, 10_000))   # fork 전 → 포함
    txn_repo.save(expense_txn(ACTUAL_SCENARIO_ID, fork, food, card, 30_000))            # fork 당일 수동 → 포함
    rule_txn = expense_txn(ACTUAL_SCENARIO_ID, fork, food, card, 777_777)
    txn_repo.save(rule_txn.model_copy(update={"source_rule_id": rule.id}))              # fork 당일 규칙 생성 → 제외
    txn_repo.save(expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 20), food, card, 888_888)) # fork 후 actual → 제외

    sc = SqliteScenarioRepository(conn).save(
        Scenario(name="가설", base_scenario_id=ACTUAL_SCENARIO_ID, fork_date=fork)
    )
    txn_repo.save(expense_txn(sc.id, fork, food, card, 5_000))          # 시나리오, fork 당일 → 포함
    txn_repo.save(expense_txn(sc.id, D(2026, 8, 1), food, card, 7_000)) # 시나리오, T 이후 → 제외(T=7/31)

    bal = q.balance_at(food, D(2026, 7, 31), sc.id)
    assert bal.amount == 10_000 + 30_000 + 5_000

    # actual_base_net_worth: 시뮬 시작 순자산도 같은 경계 규칙 (지출은 자산·부채 합에 −)
    assert q.actual_base_net_worth(fork) == -(10_000 + 30_000)


# ─── 반복 규칙 ───────────────────────────────────────────

def test_recurring_rule_roundtrip(conn, accounts):
    repo = SqliteRecurringRuleRepository(conn)
    rule = repo.save(
        RecurringRule(
            scenario_id=ACTUAL_SCENARIO_ID,
            description="월세",
            from_account_id=accounts["toss"].id,
            to_account_id=accounts["food"].id,
            amount=Money(amount=800_000),
            schedule=Schedule(spec="monthly:1"),
            start_date=D(2026, 7, 1),
        )
    )
    assert rule.id is not None
    loaded = repo.find_by_scenario(ACTUAL_SCENARIO_ID)
    assert loaded == [rule]
