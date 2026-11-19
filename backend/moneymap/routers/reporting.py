from __future__ import annotations

import datetime
from enum import IntEnum

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from moneymap.app_services.projection import (
    build_projection,
    build_dashboard_projection,
)
from moneymap.app_services.scenarios import now
from moneymap.adapters.sqlite.projection import ProjectionInputReader
from moneymap.adapters.sqlite.statistics import read_statistics
from moneymap.dependencies import repos, request_connection
from moneymap.amounts_json import MAX_SAFE_INTEGER
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    reporting_type,
)


class Months(IntEnum):
    three = 3
    six = 6
    twelve = 12


router = APIRouter(dependencies=[Depends(request_connection)])


@router.get("/api/statistics")
def statistics(
    request: Request,
    start: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
):
    if set(request.query_params) != {"start", "end"} or any(len(request.query_params.getlist(key)) != 1 for key in ("start", "end")):
        raise HTTPException(422, detail="시작일과 종료일은 하나씩 지정하세요")
    try:
        first, last = datetime.date.fromisoformat(start), datetime.date.fromisoformat(end)
    except ValueError as exc:
        raise HTTPException(422, detail="올바른 시작일과 종료일을 입력하세요") from exc
    today = now().date()
    if first > last or (last - first).days + 1 > 3660:
        raise HTTPException(422, detail="시작일 이후, 최대 3660일 범위로 조회하세요")
    if last > today:
        raise HTTPException(422, detail=f"통계 종료일은 서울 기준 오늘({today.isoformat()})까지 지정하세요")
    return {"as_of": today.isoformat(), **read_statistics(request.state.conn, first, last)}


@router.get("/api/balances")
def balances(
    request: Request,
    scenario_id: int = ACTUAL_SCENARIO_ID,
    at: datetime.date | None = None,
    krw_only: bool = False,
):
    r = repos(request)
    at = at or now().date()
    out = []
    if krw_only and scenario_id != ACTUAL_SCENARIO_ID:
        raise HTTPException(422, detail="원화 잔액은 실제 장부에서 조회하세요")
    native = {} if krw_only else r["queries"].balances_by_currency(at, scenario_id)
    raw_balances = (r["queries"].actual_krw_balances(at) if krw_only
                    else {aid: amounts.get("KRW", 0) for aid, amounts in native.items()})
    for a in r["accounts"].find_all():
        if krw_only and a.currency != "KRW":
            continue
        assert a.id is not None
        raw = raw_balances.get(a.id, 0)
        out.append(
            {
                "account_id": a.id,
                "name": a.name,
                "type": a.type.value,
                "reporting_type": reporting_type(a, raw).value,
                "balance": raw,
                **({} if krw_only else {"by_currency": {
                    currency: str(amount) for currency, amount in native.get(a.id, {}).items()
                }}),
                "display_balance": raw * a.display_multiplier(),
            }
        )
    net_worth = sum(a["balance"] for a in out if a["type"] in {"asset", "liability"})
    if krw_only:
        for row in out:
            row["balance"] = str(row["balance"])
            row["display_balance"] = str(row["display_balance"])
    return {
        "at": at.isoformat(),
        "net_worth": str(net_worth) if krw_only else net_worth,
        "accounts": out,
    }


@router.get("/api/projection")
def projection(
    request: Request, scenario_id: int = Query(..., gt=0), months: Months = Months.six
):
    if len(request.query_params.getlist("scenario_id")) != 1:
        raise HTTPException(
            422,
            detail={
                "code": "invalid_scenario_id",
                "message": "scenario_id는 하나만 지정하세요",
            },
        )
    return build_projection(
        ProjectionInputReader(request.state.conn), scenario_id, months
    )


@router.get("/api/dashboard-projection")
def dashboard_projection(
    request: Request, months: Months = Months.six, scenario_ids: str = ""
):
    try:
        ids = [int(value) for value in scenario_ids.split(",") if value.strip()]
    except ValueError as exc:
        raise HTTPException(
            400,
            detail={
                "code": "invalid_scenario_ids",
                "message": "시나리오 ID는 정수여야 합니다",
            },
        ) from exc
    if len(ids) > 3:
        raise HTTPException(
            400,
            detail={
                "code": "scenario_limit_exceeded",
                "message": "차트에는 최대 3개 시나리오만 표시됩니다",
                "maximum": 3,
            },
        )
    result = build_dashboard_projection(
        ProjectionInputReader(request.state.conn),
        repos(request)["scenarios"],
        ids,
        months,
    )
    # Plots use JavaScript numbers for coordinates. Keep representable series
    # visible and tell the reader which curve would otherwise round whole won.
    visible = []
    for series in result["series"]:
        if any(abs(p["net_worth"]) > MAX_SAFE_INTEGER for p in series["points"]):
            result["warnings"].append(f"{series['name']}: 금액이 차트의 정확한 원 단위 표시 범위를 넘었습니다.")
        else:
            visible.append(series)
    return {**result, "series": visible}
