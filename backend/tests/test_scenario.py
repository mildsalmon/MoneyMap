import datetime

import pytest
from pydantic import ValidationError

from moneymap.domain import ACTUAL_SCENARIO_ID, InvalidScenarioBaseError, Scenario

TODAY = datetime.date(2026, 7, 5)


def test_actual_scenario_shape():
    s = Scenario(id=ACTUAL_SCENARIO_ID, name="actual")
    assert s.is_actual


def test_valid_fork_from_actual():
    s = Scenario(name="월 100만 더 저축", base_scenario_id=ACTUAL_SCENARIO_ID, fork_date=TODAY)
    assert not s.is_actual


def test_past_fork_date_allowed():
    # D7-B: 과거 fork 허용
    Scenario(
        name="3개월 전부터 저축했다면",
        base_scenario_id=ACTUAL_SCENARIO_ID,
        fork_date=TODAY - datetime.timedelta(days=90),
    )


def test_nested_scenario_rejected_v1():
    # D2: 시나리오 위 시나리오 금지 (base는 actual만)
    with pytest.raises((InvalidScenarioBaseError, ValidationError)):
        Scenario(name="중첩", base_scenario_id=2, fork_date=TODAY)


def test_fork_without_date_rejected():
    with pytest.raises((InvalidScenarioBaseError, ValidationError)):
        Scenario(name="날짜 없음", base_scenario_id=ACTUAL_SCENARIO_ID)


def test_actual_with_fork_date_rejected():
    with pytest.raises((InvalidScenarioBaseError, ValidationError)):
        Scenario(name="actual인데 fork_date", fork_date=TODAY)
