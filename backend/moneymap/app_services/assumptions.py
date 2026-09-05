"""Atomic duplication and planned transactions within one scenario aggregate."""

from moneymap.domain.errors import (
    DomainConflictError,
    DomainNotFoundError,
    DomainValidationError,
)
from moneymap.domain.scenario import Scenario
from moneymap.domain.services import validate_postable_accounts
from .scenarios import get_scenario, check_etag


def duplicate_scenario(sid, body, uow):
    with uow:
        source = get_scenario(uow.scenarios, sid)
        source.require_active(assumptions=True)
        source.require_version(body.version)
        planned = uow.transactions.list_owned(sid)
        conflicts = [
            t.model_dump(mode="json") for t in planned if t.date <= body.fork_date
        ]
        if conflicts:
            raise DomainConflictError(
                "예정 거래보다 이른 시작 기준일을 선택하세요",
                code="scenario_duplicate_date_conflict",
                context={"transactions": conflicts},
            )
        rules = uow.rules.find_by_scenario(sid)
        copied = uow.scenarios.save(
            Scenario(
                name=body.name,
                description=body.description,
                fork_date=body.fork_date,
                base_scenario_id=1,
            )
        )
        for rule in rules:
            uow.rules.save(
                rule.model_copy(
                    update={
                        "id": None,
                        "scenario_id": copied.id,
                        "last_materialized": None,
                    }
                )
            )
        for txn in planned:
            uow.transactions.save(
                txn.model_copy(update={"id": None, "scenario_id": copied.id})
            )
        return {
            "scenario": copied,
            "copied": {"rules": len(rules), "planned_transactions": len(planned)},
        }


def mutate_planned(sid, tid, body, token, uow):
    with uow:
        scenario = get_scenario(uow.scenarios, sid)
        scenario.require_active(assumptions=True)
        if body is None:
            check_etag(scenario, token)
        else:
            scenario.require_version(body.scenario_version)
        existing = None
        if tid is not None:
            existing = next(
                (t for t in uow.transactions.list_owned(sid) if t.id == tid), None
            )
            if existing is None:
                raise DomainNotFoundError(
                    "이 시나리오의 예정 거래가 아닙니다", code="transaction_not_found"
                )
        txn = body.transaction(sid, tid) if body is not None else existing
        if body is not None:
            if txn.date <= scenario.fork_date:
                raise DomainConflictError(
                    "시작 기준일 다음 날 이후로 입력하세요",
                    code="scenario_transaction_date_conflict",
                )
            accounts = uow.accounts.find_all()
            validate_postable_accounts(accounts, [p.account_id for p in txn.postings])
            by_id = {account.id: account for account in accounts}
            if any(
                p.amount.currency != "KRW" or by_id[p.account_id].currency != "KRW"
                for p in txn.postings
            ):
                raise DomainValidationError(
                    "예정 거래 전망은 원화(KRW) 계정과 금액만 지원합니다",
                    code="scenario_currency_unsupported",
                )
        bumped = uow.scenarios.save(
            scenario.model_copy(update={"version": scenario.version + 1})
        )
        if body is None:
            uow.scenarios.remove_transactions(sid, [tid])
            return {
                "deleted": tid,
                "transaction": txn,
                "scenario_version": bumped.version,
            }
        saved = (
            uow.transactions.save(txn) if tid is None else uow.transactions.replace(txn)
        )
        return {"transaction": saved, "scenario_version": bumped.version}
