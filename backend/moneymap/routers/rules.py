from __future__ import annotations

import datetime


from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, ValidationError

from moneymap.adapters.sqlite.materialization import materialize_actual
from moneymap.app_services.scenarios import now
from moneymap.dependencies import repos, request_connection
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Money,
    RecurringRule,
    Schedule,
)

router = APIRouter(dependencies=[Depends(request_connection)])


class RuleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str = ""
    from_account_id: int
    to_account_id: int
    amount: int  # 양수
    schedule: str  # 'monthly:25' 등
    start_date: datetime.date
    end_date: datetime.date | None = None


@router.get("/api/rules")
def list_rules(request: Request, scenario_id: int = Query(default=1, ge=1, le=1)):
    return [
        r.model_dump() for r in repos(request)["rules"].find_by_scenario(scenario_id)
    ]


@router.post("/api/rules", status_code=201)
def create_rule(body: RuleIn, request: Request):
    try:
        rule = RecurringRule(
            scenario_id=ACTUAL_SCENARIO_ID,
            description=body.description,
            from_account_id=body.from_account_id,
            to_account_id=body.to_account_id,
            amount=Money(amount=body.amount),
            schedule=Schedule(spec=body.schedule),
            start_date=body.start_date,
            end_date=body.end_date,
        )
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return repos(request)["rules"].save(rule).model_dump()


@router.put("/api/rules/{rule_id}")
def update_rule(rule_id: int, body: RuleIn, request: Request):
    r = repos(request)
    existing = [
        x for x in r["rules"].find_by_scenario(ACTUAL_SCENARIO_ID) if x.id == rule_id
    ]
    if not existing:
        raise HTTPException(
            status_code=404,
            detail={"code": "rule_not_found", "message": "규칙이 없습니다"},
        )
    try:
        updated = RecurringRule.model_validate(
            {
                **existing[0].model_dump(),
                "description": body.description,
                "from_account_id": body.from_account_id,
                "to_account_id": body.to_account_id,
                "amount": Money(amount=body.amount),
                "schedule": Schedule(spec=body.schedule),
                "start_date": body.start_date,
                "end_date": body.end_date,
                # 과거 불변(D9): last_materialized는 유지 — 수정은 미래 실행에만 영향
            }
        )
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return r["rules"].save(updated).model_dump()


@router.delete("/api/rules/{rule_id}")
def delete_rule(rule_id: int, request: Request):
    """규칙 삭제 — 이미 생성된 거래는 독립 사본이라 남는다 (D9 과거 불변).

    생성된 거래의 source_rule_id 참조(FK)는 끊고(NULL) 지운다 —
    거래는 보존하되 출처 badge만 사라진다.
    """
    repos(request)["rules"].delete(rule_id, scenario_id=ACTUAL_SCENARIO_ID)
    return {"deleted": rule_id}


@router.post("/api/materialize")
def materialize(request: Request):
    r = repos(request)
    ids, plan = materialize_actual(r["conn"], today=now().date())
    return {
        "created": len(ids),
        "transactions": [
            {
                "id": txn_id,  # 배너의 개별 삭제(D10)용
                "date": t.date.isoformat(),
                "description": t.description,
                "source_rule_id": t.source_rule_id,
            }
            for txn_id, t in zip(ids, plan.transactions)
        ],
    }
