"""Schedule 값 객체 — 반복 규칙의 일정 DSL.

v1 형식:
    monthly:N   (N = 1..31)  예: monthly:25 = 매월 25일
    weekly:ddd  (mon..sun)   예: weekly:mon = 매주 월요일

말일 당김 (D7, 은행 컨벤션):
    monthly:31 → 2월은 28일(윤년 29일), 4·6·9·11월은 30일.
    "그 달에 없는 날짜"는 건너뛰지 않고 그 달의 마지막 날로 당긴다.
"""

from __future__ import annotations

import calendar
import datetime
import re
from collections.abc import Iterator

from pydantic import BaseModel, field_validator

from moneymap.domain.errors import InvalidScheduleError

_MONTHLY_RE = re.compile(r"^monthly:(\d{1,2})$")
_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_WEEKLY_RE = re.compile(r"^weekly:(" + "|".join(_WEEKDAYS) + r")$")


class Schedule(BaseModel):
    model_config = {"frozen": True}

    spec: str

    @field_validator("spec")
    @classmethod
    def _validate_spec(cls, v: str) -> str:
        m = _MONTHLY_RE.match(v)
        if m:
            day = int(m.group(1))
            if not 1 <= day <= 31:
                raise InvalidScheduleError(f"monthly 일자는 1~31이어야 합니다: {v!r}")
            return v
        if _WEEKLY_RE.match(v):
            return v
        raise InvalidScheduleError(
            f"지원하지 않는 일정 형식입니다: {v!r} (monthly:N 또는 weekly:ddd)"
        )

    def occurrences(
        self, start: datetime.date, end: datetime.date
    ) -> Iterator[datetime.date]:
        """[start, end] 구간(양끝 포함)의 실행 날짜를 오름차순으로 낸다."""
        if end < start:
            return

        m = _MONTHLY_RE.match(self.spec)
        if m:
            target_day = int(m.group(1))
            year, month = start.year, start.month
            while True:
                last_day = calendar.monthrange(year, month)[1]
                occ = datetime.date(year, month, min(target_day, last_day))  # 말일 당김
                if occ > end:
                    return
                if occ >= start:
                    yield occ
                year, month = (year + 1, 1) if month == 12 else (year, month + 1)
        else:
            target_wd = _WEEKDAYS.index(self.spec.split(":", 1)[1])
            delta = (target_wd - start.weekday()) % 7
            occ = start + datetime.timedelta(days=delta)
            while occ <= end:
                yield occ
                occ += datetime.timedelta(days=7)
