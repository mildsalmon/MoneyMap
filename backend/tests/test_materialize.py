"""materialize — 계획(순수) + 원자적 적용(어댑터) 테스트 (D9)."""

import datetime
import sqlite3

import pytest

from moneymap.adapters.sqlite import (
    SqliteAccountRepository,
    SqliteRecurringRuleRepository,
    SqliteTransactionRepository,
    connect,
    init_db,
)
from moneymap.adapters.sqlite.repositories import apply_materialization
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Account,
    AccountType,
    Money,
    RecurringRule,
    Schedule,
)
from moneymap.domain.materialize import MaterializationPlan, plan_materialization

D = datetime.date


def make_rule(**overrides) -> RecurringRule:
    base = dict(
        id=1,
        scenario_id=ACTUAL_SCENARIO_ID,
        description="월세",
        from_account_id=10,
        to_account_id=20,
        amount=Money(amount=800_000),
        schedule=Schedule(spec="monthly:1"),
        start_date=D(2026, 5, 1),
    )
    base.update(overrides)
    return RecurringRule(**base)


# ─── 계획 (순수) ─────────────────────────────────────────

def test_plan_from_start_to_today():
    plan = plan_materialization([make_rule()], today=D(2026, 7, 5))
    assert [t.date for t in plan.transactions] == [D(2026, 5, 1), D(2026, 6, 1), D(2026, 7, 1)]
    assert plan.watermarks == {1: D(2026, 7, 5)}
    # 거래 방향: to가 차변(+), from이 대변(−)
    t = plan.transactions[0]
    assert t.source_rule_id == 1
    amounts = {p.account_id: p.amount.amount for p in t.postings}
    assert amounts == {20: 800_000, 10: -800_000}


def test_plan_resumes_after_watermark():
    rule = make_rule(last_materialized=D(2026, 6, 15))
    plan = plan_materialization([rule], today=D(2026, 7, 5))
    assert [t.date for t in plan.transactions] == [D(2026, 7, 1)]


def test_plan_idempotent_when_up_to_date():
    """같은 날 두 번 실행해도 두 번째 계획은 비어 있다 — 이중 기입 불가의 핵심."""
    rule = make_rule(last_materialized=D(2026, 7, 5))
    plan = plan_materialization([rule], today=D(2026, 7, 5))
    assert plan.transactions == [] and plan.watermarks == {}


def test_plan_advances_watermark_even_without_occurrence():
    rule = make_rule(last_materialized=D(2026, 7, 2))  # 다음 실행일은 8/1
    plan = plan_materialization([rule], today=D(2026, 7, 20))
    assert plan.transactions == []
    assert plan.watermarks == {1: D(2026, 7, 20)}


def test_plan_respects_end_date():
    rule = make_rule(end_date=D(2026, 5, 31))
    plan = plan_materialization([rule], today=D(2026, 7, 5))
    assert [t.date for t in plan.transactions] == [D(2026, 5, 1)]
    assert plan.watermarks == {1: D(2026, 5, 31)}


def test_plan_before_start_is_empty():
    plan = plan_materialization([make_rule()], today=D(2026, 4, 1))
    assert plan.is_empty


# ─── 적용 (어댑터, 원자성) ───────────────────────────────

@pytest.fixture
def conn() -> sqlite3.Connection:
    c = connect(":memory:")
    init_db(c)
    return c


@pytest.fixture
def rule_in_db(conn) -> RecurringRule:
    acc = SqliteAccountRepository(conn)
    toss = acc.create(Account(name="Toss", type=AccountType.ASSET))
    rent = acc.create(Account(name="월세", type=AccountType.EXPENSE))
    return SqliteRecurringRuleRepository(conn).save(
        make_rule(id=None, from_account_id=toss.id, to_account_id=rent.id)
    )


def test_apply_creates_txns_and_advances_watermark(conn, rule_in_db):
    rules_repo = SqliteRecurringRuleRepository(conn)
    plan = plan_materialization([rule_in_db], today=D(2026, 7, 5))
    ids = apply_materialization(conn, plan)
    assert len(ids) == 3

    txns = SqliteTransactionRepository(conn).find_by_scenario(ACTUAL_SCENARIO_ID)
    assert len(txns) == 3
    assert all(t.source_rule_id == rule_in_db.id for t in txns)

    reloaded = rules_repo.find_by_scenario(ACTUAL_SCENARIO_ID)[0]
    assert reloaded.last_materialized == D(2026, 7, 5)

    # 재실행 → 빈 계획 → 이중 기입 없음
    plan2 = plan_materialization([reloaded], today=D(2026, 7, 5))
    assert plan2.is_empty


def test_apply_is_atomic_on_failure(conn, rule_in_db):
    """계획 중간에 실패하면 거래도 watermark도 전부 롤백 (크래시 시나리오)."""
    plan = plan_materialization([rule_in_db], today=D(2026, 7, 5))
    # 두 번째 거래를 존재하지 않는 계정으로 오염 → FK 위반으로 중간 실패 유도
    broken = plan.transactions[1].model_copy(deep=True)
    for p in broken.postings:
        object.__setattr__(p, "account_id", 99999)
    bad_plan = MaterializationPlan(
        transactions=[plan.transactions[0], broken, plan.transactions[2]],
        watermarks=plan.watermarks,
    )

    with pytest.raises(sqlite3.IntegrityError):
        apply_materialization(conn, bad_plan)

    # 아무것도 남지 않았다
    assert SqliteTransactionRepository(conn).find_by_scenario(ACTUAL_SCENARIO_ID) == []
    reloaded = SqliteRecurringRuleRepository(conn).find_by_scenario(ACTUAL_SCENARIO_ID)[0]
    assert reloaded.last_materialized is None


def test_apply_is_concurrency_safe(conn, rule_in_db):
    """같은 상태에서 세운 두 계획을 연달아 적용 — 두 번째는 선점 실패로 no-op.

    (실제 시나리오: 프론트가 /api/materialize를 동시에 두 번 호출)
    """
    plan_a = plan_materialization([rule_in_db], today=D(2026, 7, 5))
    plan_b = plan_materialization([rule_in_db], today=D(2026, 7, 5))  # 같은 전제

    ids_a = apply_materialization(conn, plan_a)
    assert len(ids_a) == 3

    ids_b = apply_materialization(conn, plan_b)  # 낙관적 잠금이 거부해야 함
    assert ids_b == []

    txns = SqliteTransactionRepository(conn).find_by_scenario(ACTUAL_SCENARIO_ID)
    assert len(txns) == 3  # 이중 기입 없음
