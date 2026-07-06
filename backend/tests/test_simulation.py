"""What-if 시뮬레이션 — 순자산 곡선·미래 기준선(D17) 테스트."""

import datetime

from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    AccountType,
    Money,
    Posting,
    RecurringRule,
    Schedule,
    Transaction,
)
from moneymap.domain.simulation import (
    net_worth_delta,
    project_net_worth,
    rule_delta_per_occurrence,
    variable_monthly_spend,
)

D = datetime.date

# 계정 타입 지도: 1=Toss(자산) 2=적금(자산) 3=카드(부채) 4=월급(수익) 5=식비(비용)
TYPES = {
    1: AccountType.ASSET,
    2: AccountType.ASSET,
    3: AccountType.LIABILITY,
    4: AccountType.INCOME,
    5: AccountType.EXPENSE,
}


def txn(date: D, legs: list[tuple[int, int]], source_rule_id: int | None = None) -> Transaction:
    return Transaction(
        scenario_id=ACTUAL_SCENARIO_ID,
        date=date,
        source_rule_id=source_rule_id,
        postings=[Posting(account_id=a, amount=Money(amount=amt)) for a, amt in legs],
    )


def rule(from_id: int, to_id: int, amount: int, spec: str, start: D, rule_id: int = 1) -> RecurringRule:
    return RecurringRule(
        id=rule_id,
        scenario_id=ACTUAL_SCENARIO_ID,
        from_account_id=from_id,
        to_account_id=to_id,
        amount=Money(amount=amount),
        schedule=Schedule(spec=spec),
        start_date=start,
    )


# ─── 순자산 변화 규칙 ────────────────────────────────────

def test_income_to_asset_increases_net_worth():
    t = txn(D(2026, 7, 25), [(1, 3_000_000), (4, -3_000_000)])  # 월급
    assert net_worth_delta(t, TYPES) == 3_000_000


def test_asset_to_expense_decreases_net_worth():
    t = txn(D(2026, 7, 1), [(5, 800_000), (1, -800_000)])  # 월세
    assert net_worth_delta(t, TYPES) == -800_000


def test_asset_to_asset_transfer_is_neutral():
    t = txn(D(2026, 7, 26), [(2, 1_000_000), (1, -1_000_000)])  # 적금 이체
    assert net_worth_delta(t, TYPES) == 0


def test_card_payment_is_neutral():
    # 카드값 납부: 부채 감소(차변+) / 자산 감소(대변−) → 순자산 불변
    t = txn(D(2026, 7, 14), [(3, 500_000), (1, -500_000)])
    assert net_worth_delta(t, TYPES) == 0


def test_rule_delta_matches_txn_delta():
    salary = rule(4, 1, 3_000_000, "monthly:25", D(2026, 1, 1))
    assert rule_delta_per_occurrence(salary, TYPES) == 3_000_000
    saving = rule(1, 2, 1_000_000, "monthly:26", D(2026, 1, 1))
    assert rule_delta_per_occurrence(saving, TYPES) == 0


# ─── 미래 기준선: 변동지출 월평균 (D17) ──────────────────

def test_variable_spend_excludes_rule_generated():
    txns = [
        txn(D(2026, 6, 10), [(5, 300_000), (1, -300_000)]),                    # 수동 지출 → 포함
        txn(D(2026, 6, 1), [(5, 800_000), (1, -800_000)], source_rule_id=7),   # 규칙 생성 → 제외
        txn(D(2026, 5, 20), [(5, 150_000), (3, -150_000)]),                    # 수동 카드 지출 → 포함
    ]
    # 기록 약 1.5개월 → 나눗셈 분모 = 1 (보수적)
    avg = variable_monthly_spend(txns, TYPES, window_end=D(2026, 7, 5))
    assert avg == 450_000


def test_variable_spend_full_window_averages():
    txns = [
        txn(D(2026, 4, 10), [(5, 300_000), (1, -300_000)]),
        txn(D(2026, 5, 10), [(5, 300_000), (1, -300_000)]),
        txn(D(2026, 6, 10), [(5, 300_000), (1, -300_000)]),
        txn(D(2026, 1, 1), [(5, 999), (1, -999)]),  # 창 밖(1월) → 제외, 기록 길이만 늘림
    ]
    avg = variable_monthly_spend(txns, TYPES, window_end=D(2026, 7, 5))
    assert avg == 300_000  # 900,000 / 3개월


def test_variable_spend_no_records_is_zero():
    assert variable_monthly_spend([], TYPES, window_end=D(2026, 7, 5)) == 0


# ─── 순자산 곡선 (fold) ─────────────────────────────────

def test_projection_with_salary_and_rent():
    salary = rule(4, 1, 3_000_000, "monthly:25", D(2026, 1, 1), rule_id=1)
    rent = rule(1, 5, 800_000, "monthly:1", D(2026, 1, 1), rule_id=2)
    curve = project_net_worth(
        start_net_worth=10_000_000,
        start=D(2026, 7, 5),
        end=D(2026, 8, 31),
        rules=[salary, rent],
        account_types=TYPES,
    )
    assert curve[0] == (D(2026, 7, 5), 10_000_000)
    assert dict(curve)[D(2026, 7, 25)] == 13_000_000            # +월급
    assert dict(curve)[D(2026, 8, 1)] == 12_200_000             # −월세
    assert curve[-1] == (D(2026, 8, 25), 15_200_000)            # +월급
    assert [d for d, _ in curve] == sorted(d for d, _ in curve)


def test_projection_neutral_rules_produce_flat_curve():
    saving = rule(1, 2, 1_000_000, "monthly:26", D(2026, 1, 1))
    curve = project_net_worth(
        start_net_worth=5_000_000,
        start=D(2026, 7, 1),
        end=D(2026, 9, 30),
        rules=[saving],
        account_types=TYPES,
    )
    assert curve == [(D(2026, 7, 1), 5_000_000)]  # 자산↔자산은 곡선에 안 나타남


def test_projection_variable_spend_hits_month_ends():
    curve = project_net_worth(
        start_net_worth=10_000_000,
        start=D(2026, 7, 5),
        end=D(2026, 8, 31),
        rules=[],
        account_types=TYPES,
        monthly_variable_spend=500_000,
    )
    assert dict(curve)[D(2026, 7, 31)] == 9_500_000
    assert dict(curve)[D(2026, 8, 31)] == 9_000_000


def test_projection_start_day_occurrence_absorbed_into_opening():
    salary = rule(4, 1, 3_000_000, "monthly:25", D(2026, 1, 1))
    curve = project_net_worth(
        start_net_worth=1_000_000,
        start=D(2026, 7, 25),  # 시작일 = 월급날
        end=D(2026, 7, 31),
        rules=[salary],
        account_types=TYPES,
    )
    assert curve[0] == (D(2026, 7, 25), 4_000_000)


def test_optimism_bias_prevented():
    """D17의 존재 이유: 변동지출 없이 계산하면 기준선이 체계적으로 높다."""
    salary = rule(4, 1, 3_000_000, "monthly:25", D(2026, 1, 1))
    kwargs = dict(
        start_net_worth=0,
        start=D(2026, 7, 1),
        end=D(2027, 6, 30),
        rules=[salary],
        account_types=TYPES,
    )
    naive = project_net_worth(**kwargs)[-1][1]
    realistic = project_net_worth(**kwargs, monthly_variable_spend=820_000)[-1][1]
    assert naive == 36_000_000
    assert realistic == 36_000_000 - 820_000 * 12
