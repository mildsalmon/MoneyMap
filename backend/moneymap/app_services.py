"""애플리케이션 서비스 — 유스케이스 조립 레이어.

도메인(순수)과 포트만 의존한다. FastAPI(인바운드)와 SQLite(아웃바운드)
사이에서 시나리오 fork, 순자산 곡선 조립 같은 흐름을 담당한다.
"""

from __future__ import annotations

import calendar
import datetime

from moneymap.domain.account import Account, AccountType
from moneymap.domain.ports import (
    RecurringRuleRepository,
    ScenarioRepository,
    TransactionRepository,
)
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID, Scenario
from moneymap.domain.simulation import (
    net_worth_delta,
    project_net_worth,
    variable_monthly_spend,
)


def add_months(d: datetime.date, months: int) -> datetime.date:
    """월 산술 (말일 당김과 같은 규칙으로 일자 클램프)."""
    total = d.year * 12 + (d.month - 1) + months
    year, month = divmod(total, 12)
    month += 1
    return datetime.date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def fork_scenario(
    name: str,
    fork_date: datetime.date,
    scenario_repo: ScenarioRepository,
    rule_repo: RecurringRuleRepository,
) -> tuple[Scenario, int]:
    """시나리오 생성 = scenarios 행 + actual 규칙 복사 (copy-on-fork, D5).

    복사본은 스냅샷 — 이후 actual 규칙 변경은 이 시나리오에 반영되지 않는다.
    반환: (저장된 시나리오, 복사된 규칙 수)
    """
    saved = scenario_repo.save(
        Scenario(name=name, base_scenario_id=ACTUAL_SCENARIO_ID, fork_date=fork_date)
    )
    assert saved.id is not None
    actual_rules = rule_repo.find_by_scenario(ACTUAL_SCENARIO_ID)
    for rule in actual_rules:
        rule_repo.save(
            rule.model_copy(
                update={"id": None, "scenario_id": saved.id, "last_materialized": None}
            )
        )
    return saved, len(actual_rules)


def actual_net_worth_history(
    txn_repo: TransactionRepository,
    account_types: dict[int, AccountType],
    end: datetime.date,
) -> list[tuple[datetime.date, int]]:
    """기록 시작일~end의 실제 순자산 곡선 (D11: 시작일 이전은 그리지 않음)."""
    txns = txn_repo.find_by_scenario(ACTUAL_SCENARIO_ID, end=end)
    if not txns:
        return []
    deltas: dict[datetime.date, int] = {}
    for t in txns:
        d = net_worth_delta(t, account_types)
        if d:
            deltas[t.date] = deltas.get(t.date, 0) + d
    curve: list[tuple[datetime.date, int]] = []
    net = 0
    for day in sorted(deltas):
        net += deltas[day]
        curve.append((day, net))
    return curve


class ProjectionSeries(dict):
    """직렬화 편의를 위한 dict 서브클래스 (JSON 그대로 반환)."""


def build_projection(
    *,
    accounts: list[Account],
    txn_repo: TransactionRepository,
    rule_repo: RecurringRuleRepository,
    scenario_repo: ScenarioRepository,
    net_worth_at,  # (at, scenario_id) -> int          — LedgerQueries의 메서드
    actual_base_net_worth,  # (fork: date) -> int      — fork 경계의 actual 쪽 순자산
    today: datetime.date,
    months: int,
    scenario_ids: list[int],
) -> list[dict]:
    """차트용 시리즈 3종 조립 (UI 스펙):

      1. '실제' — 기록 시작일~오늘, 오늘에서 끊김 (D17)
      2. '현재 패턴 유지' — actual 규칙 + 변동지출 3개월 평균 (D17 기준선)
      3. 각 시나리오 — fork 시점부터: 자기 규칙(copy-on-fork) + 수동 거래
                       + 같은 변동지출 (비교의 공정성)
    """
    account_types = {a.id: a.type for a in accounts if a.id is not None}
    end = add_months(today, months)

    actual_txns = txn_repo.find_by_scenario(ACTUAL_SCENARIO_ID, end=today)
    variable = variable_monthly_spend(actual_txns, account_types, window_end=today)

    def pts(curve: list[tuple[datetime.date, int]]) -> list[dict]:
        return [{"date": d.isoformat(), "net_worth": v} for d, v in curve]

    series: list[dict] = []

    # 1. 실제 (과거만 — 오늘에서 끊김)
    series.append(
        {
            "id": "actual",
            "name": "실제",
            "kind": "actual",
            "points": pts(actual_net_worth_history(txn_repo, account_types, today)),
        }
    )

    # 2. 현재 패턴 유지 (미래 기준선)
    baseline_curve = project_net_worth(
        start_net_worth=net_worth_at(today, ACTUAL_SCENARIO_ID),
        start=today,
        end=end,
        rules=rule_repo.find_by_scenario(ACTUAL_SCENARIO_ID),
        account_types=account_types,
        monthly_variable_spend=variable,
    )
    series.append(
        {
            "id": "baseline",
            "name": "현재 패턴 유지",
            "kind": "baseline",
            "basis": {"monthly_variable_spend": variable},  # 근거 툴팁용 (D17)
            "points": pts(baseline_curve),
        }
    )

    # 3. 시나리오들
    for sid in scenario_ids:
        sc = scenario_repo.find_by_id(sid)
        if sc is None or sc.fork_date is None:
            continue
        sim_start = sc.fork_date
        # 시작 순자산 = fork 경계의 actual 쪽 (fork 이전 + fork 당일 수동 입력.
        # 규칙 생성분은 제외 — 시뮬레이션이 그날부터 전개하므로 중복 방지)
        start_nw = actual_base_net_worth(sim_start)
        curve = project_net_worth(
            start_net_worth=start_nw,
            start=sim_start,
            end=end,
            rules=rule_repo.find_by_scenario(sid),
            account_types=account_types,
            monthly_variable_spend=variable,
            transactions=txn_repo.find_by_scenario(sid, start=sim_start, end=end),
        )
        series.append(
            {"id": sid, "name": sc.name, "kind": "scenario", "points": pts(curve)}
        )

    return series
