from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from moneymap import app_services
from moneymap.adapters.sqlite.uow import SqliteUnitOfWork
from moneymap.dependencies import repos, request_connection

router = APIRouter(dependencies=[Depends(request_connection)])


class ScenarioIn(BaseModel):
    name: str = Field(min_length=1)
    fork_date: datetime.date  # 기본값(오늘)은 프론트가 채움 (D7-B)


@router.get("/api/scenarios")
def list_scenarios(request: Request):
    return [
        s.model_dump()
        for s in repos(request)["scenarios"].list_all()
        if not s.is_actual
    ]


@router.post("/api/scenarios", status_code=201)
def create_scenario(body: ScenarioIn, request: Request):
    r = repos(request)
    scenario, copied = app_services.fork_scenario(
        body.name, body.fork_date, SqliteUnitOfWork(r["conn"])
    )
    return {**scenario.model_dump(), "copied_rules": copied}
