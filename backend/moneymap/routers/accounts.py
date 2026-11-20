from __future__ import annotations

import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from moneymap.adapters.sqlite.account_history import account_events, correct_date, dated_accounts
from moneymap import app_services
from moneymap.dependencies import repos, request_connection
from moneymap.domain import (
    Account,
    AccountSettingsCommand,
    AccountType,
)
from moneymap.domain.account_order import AccountReorderCommand
from moneymap.domain.standard_accounts import STANDARD_ACCOUNTS

router = APIRouter(dependencies=[Depends(request_connection)])

@router.put("/api/accounts/reorder")
def reorder_accounts(body: AccountReorderCommand, request: Request):
    return app_services.reorder_accounts(body, repos(request)["accounts"]).model_dump()


class AccountIn(BaseModel):
    parent_versions: dict[int, int] = Field(default_factory=dict)
    request_id: UUID | None = None
    name: str
    type: AccountType
    parent_id: int | None = None
    is_placeholder: bool = False
    is_overdraft: bool = False


class AccountSettingsIn(BaseModel):
    parent_versions: dict[int, int] = Field(default_factory=dict)
    effective_date: datetime.date | None = None
    include_in_cash: bool | None = None
    name: str
    parent_id: int | None
    is_overdraft: bool
    version: int = Field(ge=1)


class CorrectionIn(BaseModel):
    effective_date: datetime.date
    expected_revision: int = Field(ge=0)


class PlaceholderIn(BaseModel):
    is_placeholder: bool


class OpeningBalanceIn(BaseModel):
    date: datetime.date
    amount: int
    state: str


@router.get("/api/accounts")
def list_accounts(request: Request, on: datetime.date | None = None):
    if on is not None:
        accounts, known = dated_accounts(request.state.conn, on)
        parents = dict(request.state.conn.execute("SELECT id,parent_id FROM accounts"))
        return [dict(a.model_dump(), history_known=known, current_parent_id=parents[a.id]) for a in accounts]
    return [a.model_dump() for a in repos(request)["accounts"].find_all()]


@router.get("/api/accounts/{account_id}/state-history")
def state_history(account_id: int, request: Request):
    return account_events(request.state.conn, account_id)


@router.post("/api/accounts/{account_id}/state-history/{seq}/corrections")
def correct_account_date(account_id: int, seq: int, body: CorrectionIn, request: Request):
    return correct_date(request.state.conn, account_id, seq, body.effective_date, body.expected_revision)


@router.post("/api/accounts", status_code=201)
def create_account(body: AccountIn, request: Request):
    r = repos(request)
    account = Account(
        name=body.name,
        type=body.type,
        parent_id=body.parent_id,
        is_placeholder=body.is_placeholder,
        is_overdraft=body.is_overdraft,
    )
    request_id = str(body.request_id) if body.request_id else None
    return r["accounts"].create(account, request_id, body.parent_versions).model_dump()


@router.get("/api/accounts/creation-requests/{request_id}")
def account_creation_result(request_id: UUID, request: Request):
    return repos(request)["accounts"].creation_result(str(request_id))


@router.put("/api/accounts/{account_id}/settings")
def update_account_settings(
    account_id: int,
    body: AccountSettingsIn,
    request: Request,
):
    result = app_services.update_account_settings(
        AccountSettingsCommand(
            account_id=account_id,
            parent_versions=body.parent_versions,
            name=body.name,
            parent_id=body.parent_id,
            is_overdraft=body.is_overdraft,
            include_in_cash=body.include_in_cash,
            version=body.version,
            effective_date=body.effective_date,
        ),
        repos(request)["accounts"],
    )
    return result.model_dump()


@router.post("/api/accounts/seed-standard")
def seed_standard_accounts(request: Request):
    """표준 계정과목 시드 — repository의 한 트랜잭션에서 path 기준 멱등."""
    created, skipped = repos(request)["accounts"].seed_standard(STANDARD_ACCOUNTS)
    return {"created": created, "skipped": skipped}


@router.post("/api/accounts/{account_id}/placeholder")
def set_placeholder(account_id: int, body: PlaceholderIn, request: Request, effective_date: datetime.date | None = None):
    return (
        repos(request)["accounts"]
        .set_placeholder(account_id, body.is_placeholder, effective_date)
        .model_dump()
    )


@router.post("/api/accounts/{account_id}/archive")
def archive_account(account_id: int, request: Request, effective_date: datetime.date | None = None):
    return repos(request)["accounts"].set_archived(account_id, True, effective_date).model_dump()


@router.post("/api/accounts/{account_id}/restore")
def restore_account(account_id: int, request: Request, effective_date: datetime.date | None = None):
    return repos(request)["accounts"].set_archived(account_id, False, effective_date).model_dump()


@router.post("/api/accounts/{account_id}/reclassify-direct")
def reclassify_direct_postings(account_id: int, request: Request, to: int = Query(...)):
    return {
        "moved_postings": repos(request)["accounts"].reclassify_direct(account_id, to),
        "to": to,
    }


@router.post("/api/accounts/{account_id}/opening-balance", status_code=201)
def create_opening_balance(
    account_id: int,
    body: OpeningBalanceIn,
    request: Request,
):
    return app_services.create_opening_balance(
        account_id,
        body.date,
        body.amount,
        body.state,
        repos(request)["txns"],
    ).model_dump()
