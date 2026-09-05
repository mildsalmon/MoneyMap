"""Lifecycle commands: guard precedence and one aggregate commit per command."""

from __future__ import annotations

import datetime as dt
import re
from zoneinfo import ZoneInfo

from moneymap.domain.errors import DomainError, DomainConflictError, DomainNotFoundError
from moneymap.domain.scenario import Scenario
from moneymap.domain.services import validate_postable_accounts


def now():
    return dt.datetime.now(ZoneInfo("Asia/Seoul"))


def get_scenario(repo, sid: int) -> Scenario:
    scenario = repo.find_by_id(sid)
    if scenario is None:
        raise DomainNotFoundError("시나리오가 없습니다", code="scenario_not_found")
    return scenario


def etag(scenario: Scenario) -> str:
    return f'"scenario-{scenario.id}-v{scenario.version}"'


def check_etag(scenario: Scenario, value: str | None, *, context: dict | None = None):
    if value is None:
        error = DomainError(
            "삭제 영향 정보를 먼저 확인하세요", code="scenario_version_required"
        )
        error.status_code = 428
        raise error
    if not re.fullmatch(r'"scenario-[1-9][0-9]*-v[1-9][0-9]*"', value):
        raise DomainError(
            "올바른 strong ETag가 필요합니다", code="invalid_scenario_version"
        )
    if value != etag(scenario):
        error = DomainConflictError(
            "변경된 영향을 확인한 뒤 다시 확인하세요",
            code="scenario_version_conflict",
            context=context or {"current_version": scenario.version},
        )
        error.status_code = 412
        raise error


def create_scenario(name, description, fork_date, uow):
    with uow:
        saved = uow.scenarios.save(
            Scenario(
                name=name,
                description=description,
                base_scenario_id=1,
                fork_date=fork_date,
            )
        )
        return {
            "scenario": saved,
            "effective_actual_rules": len(uow.rules.find_by_scenario(1)),
        }


def edit_scenario(sid, name, description, version, uow):
    with uow:
        scenario = get_scenario(uow.scenarios, sid)
        scenario.require_active()
        scenario.require_version(version)
        return uow.scenarios.save(scenario.renamed(name, description))


def transition(sid, target, version, uow):
    with uow:
        scenario = get_scenario(uow.scenarios, sid)
        scenario.protect_actual()
        if scenario.status == target:
            return scenario
        scenario.require_version(version)
        return uow.scenarios.save(scenario.transitioned(target, now()))


def delete_scenario(sid, token, uow):
    with uow:
        scenario = get_scenario(uow.scenarios, sid)
        scenario.protect_actual()
        if scenario.status != "archived":
            raise DomainConflictError(
                "먼저 시나리오를 보관하세요", code="scenario_state_conflict"
            )
        impact = uow.scenarios.impact(scenario)
        check_etag(scenario, token, context={"impact": impact, "etag": etag(scenario)})
        uow.scenarios.delete(sid)
        return {
            "deleted": sid,
            **{
                k: impact[k]
                for k in (
                    "rules",
                    "planned_transactions",
                    "generated_transactions",
                    "postings",
                )
            },
        }


def mutate_rule(sid, rid, version, token, make_rule, uow):
    with uow:
        scenario = get_scenario(uow.scenarios, sid)
        scenario.require_active(assumptions=True)
        if make_rule is None:
            check_etag(scenario, token)
        else:
            scenario.require_version(version)
        if rid is not None and not any(
            r.id == rid for r in uow.rules.find_by_scenario(sid)
        ):
            raise DomainNotFoundError(
                "이 시나리오의 규칙이 아닙니다", code="rule_not_found"
            )
        rule = make_rule() if make_rule else None
        if rule:
            validate_postable_accounts(
                uow.accounts.find_all(),
                [rule.from_account_id, rule.to_account_id],
                for_rule=True,
            )
        bumped = uow.scenarios.save(
            scenario.model_copy(update={"version": scenario.version + 1})
        )
        if rule:
            return {"rule": uow.rules.save(rule), "scenario_version": bumped.version}
        uow.rules.delete_owned(rid, sid)
        return {"deleted": rid, "scenario_version": bumped.version}


def legacy_resolution(scenario, rules, repo):
    scenario.protect_actual()
    owned = rules.find_by_scenario(scenario.id)
    actual = rules.find_by_scenario(1)
    transactions = repo.transaction_summaries(scenario.id)
    return {
        "scenario": scenario,
        "rules": [
            {
                "legacy_rule_id": r.id,
                "rule": r,
                "actual_candidates": [
                    a
                    for a in actual
                    if (a.from_account_id, a.to_account_id, a.schedule.spec)
                    == (r.from_account_id, r.to_account_id, r.schedule.spec)
                ],
            }
            for r in owned
        ],
        "transaction_conflicts": [
            t
            for t in transactions
            if t["source_rule_id"] is None
            and t["date"] <= scenario.fork_date.isoformat()
        ],
        "generated_transactions": sum(
            t["source_rule_id"] is not None for t in transactions
        ),
    }


def resolve_legacy(sid, body, uow):
    with uow:
        scenario = get_scenario(uow.scenarios, sid)
        scenario.require_active()
        scenario.require_version(body.version, code="legacy_rule_resolution_stale")
        if scenario.rule_mode != "legacy_snapshot":
            raise DomainConflictError(
                "이미 변환된 시나리오입니다", code="scenario_state_conflict"
            )
        resolution = legacy_resolution(scenario, uow.rules, uow.scenarios)
        rules = body.rule_decisions
        transactions = body.transaction_decisions
        expected_rules = {r["legacy_rule_id"] for r in resolution["rules"]}
        expected_txns = {t["id"] for t in resolution["transaction_conflicts"]}
        if (
            len(rules) != len(expected_rules)
            or {r.legacy_rule_id for r in rules} != expected_rules
            or len(transactions) != len(expected_txns)
            or {t.transaction_id for t in transactions} != expected_txns
        ):
            raise DomainConflictError(
                "모든 기존 규칙과 날짜 충돌을 한 번씩 분류하세요",
                code="legacy_rule_resolution_stale",
            )
        for t in transactions:
            if t.action == "move" and (t.date is None or t.date <= scenario.fork_date):
                raise DomainConflictError(
                    "시작 기준일 다음 날 이후로 옮기세요",
                    code="scenario_transaction_date_conflict",
                )
        bumped = scenario.model_copy(
            update={"rule_mode": "live_additive", "version": scenario.version + 1}
        )
        uow.scenarios.save(bumped)
        generated = [
            t["id"]
            for t in uow.scenarios.transaction_summaries(sid)
            if t["source_rule_id"] is not None
        ]
        removed = generated + [
            t.transaction_id for t in transactions if t.action == "delete"
        ]
        uow.scenarios.remove_transactions(sid, removed)
        for t in transactions:
            if t.action == "move":
                uow.scenarios.move_transaction(sid, t.transaction_id, t.date)
        for r in rules:
            if r.action == "discard_snapshot":
                uow.rules.delete_owned(r.legacy_rule_id, sid)
        return {
            "scenario": bumped,
            "removed_rules": sum(r.action == "discard_snapshot" for r in rules),
            "kept_rules": sum(r.action == "keep_as_scenario" for r in rules),
            "removed_transactions": len(removed),
            "moved_transactions": sum(t.action == "move" for t in transactions),
        }
