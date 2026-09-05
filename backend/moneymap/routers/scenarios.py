from __future__ import annotations

import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Header, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from moneymap.app_services import scenarios as service
from moneymap.adapters.sqlite.uow import SqliteUnitOfWork
from moneymap.dependencies import repos, request_connection
from moneymap.domain import Money, RecurringRule, Schedule
from moneymap.domain.projection import EffectiveRuleResolver

router = APIRouter(dependencies=[Depends(request_connection)])


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ScenarioIn(StrictBody):
    name: str = Field(min_length=1)
    description: str = ""
    fork_date: datetime.date

    @field_validator("name")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("이름을 입력하세요")
        return value.strip()

    @field_validator("fork_date")
    @classmethod
    def past_or_today(cls, value):
        if value > service.now().date():
            raise ValueError("시작 기준일은 오늘 또는 과거여야 합니다")
        return value


class VersionIn(StrictBody):
    version: int = Field(gt=0)


class EditIn(VersionIn):
    name: str = Field(min_length=1)
    description: str = ""
    _nonblank = field_validator("name")(ScenarioIn.nonblank.__func__)


class RuleIn(StrictBody):
    description: str = ""
    from_account_id: int
    to_account_id: int
    amount: int
    schedule: str
    start_date: datetime.date
    end_date: datetime.date | None = None
    scenario_version: int = Field(gt=0)

    def rule(self, sid, rid=None):
        return RecurringRule(
            id=rid,
            scenario_id=sid,
            **self.model_dump(exclude={"scenario_version", "amount", "schedule"}),
            amount=Money(amount=self.amount),
            schedule=Schedule(spec=self.schedule),
        )


class RuleDecision(StrictBody):
    legacy_rule_id: int
    action: Literal["discard_snapshot", "keep_as_scenario"]


class TransactionDecision(StrictBody):
    transaction_id: int
    action: Literal["move", "delete"]
    date: datetime.date | None = None


class ResolutionIn(VersionIn):
    rule_decisions: list[RuleDecision]
    transaction_decisions: list[TransactionDecision]


def uow(request):
    return SqliteUnitOfWork(request.state.conn)


@router.get("/api/scenarios")
def list_scenarios(request: Request, status: Literal["active", "archived"] = "active"):
    return repos(request)["scenarios"].list_all(status)


@router.post("/api/scenarios", status_code=201)
def create_scenario(body: ScenarioIn, request: Request):
    return service.create_scenario(
        body.name, body.description, body.fork_date, uow(request)
    )


@router.get("/api/scenarios/{sid}")
def detail(sid: int, request: Request):
    return service.get_scenario(repos(request)["scenarios"], sid)


@router.patch("/api/scenarios/{sid}")
def edit(sid: int, body: EditIn, request: Request):
    return service.edit_scenario(
        sid, body.name, body.description, body.version, uow(request)
    )


@router.post("/api/scenarios/{sid}/archive")
def archive(sid: int, body: VersionIn, request: Request):
    return service.transition(sid, "archived", body.version, uow(request))


@router.post("/api/scenarios/{sid}/restore")
def restore(sid: int, body: VersionIn, request: Request):
    return service.transition(sid, "active", body.version, uow(request))


@router.get("/api/scenarios/{sid}/deletion-impact")
def impact(sid: int, request: Request, response: Response):
    repository = repos(request)["scenarios"]
    scenario = service.get_scenario(repository, sid)
    scenario.protect_actual()
    response.headers["ETag"] = service.etag(scenario)
    return repository.impact(scenario)


@router.delete("/api/scenarios/{sid}")
def delete(sid: int, request: Request, if_match: str | None = Header(default=None)):
    return service.delete_scenario(sid, if_match, uow(request))


@router.get("/api/scenarios/{sid}/effective-rules")
def effective_rules(sid: int, request: Request):
    r = repos(request)
    scenario = service.get_scenario(r["scenarios"], sid)
    return EffectiveRuleResolver.resolve(
        scenario, r["rules"].find_by_scenario(1), r["rules"].find_by_scenario(sid)
    )


@router.get("/api/scenarios/{sid}/rules")
def owned_rules(sid: int, request: Request):
    r = repos(request)
    service.get_scenario(r["scenarios"], sid).protect_actual()
    return r["rules"].find_by_scenario(sid)


@router.post("/api/scenarios/{sid}/rules", status_code=201)
def add_rule(sid: int, body: RuleIn, request: Request):
    return service.mutate_rule(
        sid, None, body.scenario_version, None, lambda: body.rule(sid), uow(request)
    )


@router.put("/api/scenarios/{sid}/rules/{rid}")
def edit_rule(sid: int, rid: int, body: RuleIn, request: Request):
    return service.mutate_rule(
        sid, rid, body.scenario_version, None, lambda: body.rule(sid, rid), uow(request)
    )


@router.delete("/api/scenarios/{sid}/rules/{rid}")
def delete_rule(
    sid: int, rid: int, request: Request, if_match: str | None = Header(default=None)
):
    return service.mutate_rule(sid, rid, None, if_match, None, uow(request))


@router.get("/api/scenarios/{sid}/legacy-rule-resolution")
def legacy(sid: int, request: Request):
    r = repos(request)
    return service.legacy_resolution(
        service.get_scenario(r["scenarios"], sid), r["rules"], r["scenarios"]
    )


@router.post("/api/scenarios/{sid}/legacy-rule-resolution")
def resolve(sid: int, body: ResolutionIn, request: Request):
    return service.resolve_legacy(sid, body, uow(request))
