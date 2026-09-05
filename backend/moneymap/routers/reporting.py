from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from moneymap import app_services
from moneymap.dependencies import repos, request_connection
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    reporting_type,
)

router = APIRouter(dependencies=[Depends(request_connection)])


@router.get("/api/balances")
def balances(
    request: Request,
    scenario_id: int = ACTUAL_SCENARIO_ID,
    at: datetime.date | None = None,
):
    r = repos(request)
    at = at or datetime.date.today()
    out = []
    for a in r["accounts"].find_all():
        assert a.id is not None
        raw = r["queries"].balance_at(a.id, at, scenario_id).amount
        out.append(
            {
                "account_id": a.id,
                "name": a.name,
                "type": a.type.value,
                "reporting_type": reporting_type(a, raw).value,
                "balance": raw,
                "display_balance": raw * a.display_multiplier(),
            }
        )
    return {
        "at": at.isoformat(),
        "net_worth": r["queries"].net_worth_at(at, scenario_id),
        "accounts": out,
    }


@router.get("/api/projection")
def projection(
    request: Request,
    months: int = Query(default=12, ge=1, le=60),
    scenario_ids: str = "",  # "2,3"
):
    r = repos(request)
    try:
        ids = [int(s) for s in scenario_ids.split(",") if s.strip()]
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_scenario_ids",
                "message": "시나리오 ID는 정수여야 합니다",
            },
        ) from exc
    if len(ids) > 3:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "scenario_limit_exceeded",
                "message": "차트에는 최대 3개 시나리오만 표시됩니다 (D19)",
                "maximum": 3,
            },
        )
    return {
        "series": app_services.build_projection(
            accounts=r["accounts"].find_all(),
            txn_repo=r["txns"],
            rule_repo=r["rules"],
            scenario_repo=r["scenarios"],
            net_worth_at=r["queries"].net_worth_at,
            actual_base_net_worth=r["queries"].actual_base_net_worth,
            today=datetime.date.today(),
            months=months,
            scenario_ids=ids,
        )
    }
