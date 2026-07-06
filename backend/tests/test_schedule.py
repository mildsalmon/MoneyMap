import datetime

import pytest
from pydantic import ValidationError

from moneymap.domain import InvalidScheduleError, Schedule

D = datetime.date


def occs(spec: str, start: D, end: D) -> list[D]:
    return list(Schedule(spec=spec).occurrences(start, end))


def test_monthly_normal_day():
    assert occs("monthly:25", D(2026, 7, 1), D(2026, 9, 30)) == [
        D(2026, 7, 25),
        D(2026, 8, 25),
        D(2026, 9, 25),
    ]


def test_monthly_31_clamps_to_end_of_month():
    # 말일 당김 (D7): 2월 28일(평년), 4월 30일, 그 외 31일
    assert occs("monthly:31", D(2026, 1, 1), D(2026, 4, 30)) == [
        D(2026, 1, 31),
        D(2026, 2, 28),
        D(2026, 3, 31),
        D(2026, 4, 30),
    ]


def test_monthly_29_leap_year():
    # 2028년은 윤년 → 2월 29일 그대로, 2027년(평년)은 28일로 당김
    assert occs("monthly:29", D(2027, 2, 1), D(2027, 2, 28)) == [D(2027, 2, 28)]
    assert occs("monthly:29", D(2028, 2, 1), D(2028, 2, 29)) == [D(2028, 2, 29)]


def test_monthly_boundaries_inclusive():
    # 시작일·종료일 당일도 포함
    assert occs("monthly:25", D(2026, 7, 25), D(2026, 7, 25)) == [D(2026, 7, 25)]


def test_monthly_start_after_day_skips_first_month():
    assert occs("monthly:10", D(2026, 7, 15), D(2026, 8, 31)) == [D(2026, 8, 10)]


def test_weekly():
    # 2026-07-06은 월요일
    assert occs("weekly:mon", D(2026, 7, 5), D(2026, 7, 20)) == [
        D(2026, 7, 6),
        D(2026, 7, 13),
        D(2026, 7, 20),
    ]


def test_empty_range():
    assert occs("monthly:25", D(2026, 7, 26), D(2026, 7, 25)) == []


@pytest.mark.parametrize(
    "bad", ["monthly:0", "monthly:32", "weekly:funday", "daily", "monthly:", "yearly:1"]
)
def test_invalid_spec_rejected(bad: str):
    with pytest.raises((InvalidScheduleError, ValidationError)):
        Schedule(spec=bad)
