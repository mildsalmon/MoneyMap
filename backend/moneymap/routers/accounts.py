from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field

from moneymap import app_services
from moneymap.dependencies import repos, request_connection
from moneymap.domain import (
    Account,
    AccountSettingsCommand,
    AccountType,
)
from moneymap.domain.standard_accounts import STANDARD_ACCOUNTS

router = APIRouter(dependencies=[Depends(request_connection)])


class AccountIn(BaseModel):
    name: str
    type: AccountType
    parent_id: int | None = None
    is_placeholder: bool = False
    is_overdraft: bool = False


class AccountSettingsIn(BaseModel):
    name: str
    parent_id: int | None
    is_overdraft: bool
    version: int = Field(ge=1)


class PlaceholderIn(BaseModel):
    is_placeholder: bool


class OpeningBalanceIn(BaseModel):
    date: datetime.date
    amount: int
    state: str


@router.get("/api/accounts")
def list_accounts(request: Request):
    return [a.model_dump() for a in repos(request)["accounts"].find_all()]


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
    return r["accounts"].create(account).model_dump()


@router.put("/api/accounts/{account_id}/settings")
def update_account_settings(
    account_id: int,
    body: AccountSettingsIn,
    request: Request,
):
    result = app_services.update_account_settings(
        AccountSettingsCommand(
            account_id=account_id,
            name=body.name,
            parent_id=body.parent_id,
            is_overdraft=body.is_overdraft,
            version=body.version,
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
def set_placeholder(account_id: int, body: PlaceholderIn, request: Request):
    return (
        repos(request)["accounts"]
        .set_placeholder(account_id, body.is_placeholder)
        .model_dump()
    )


@router.post("/api/accounts/{account_id}/archive")
def archive_account(account_id: int, request: Request):
    return repos(request)["accounts"].set_archived(account_id, True).model_dump()


@router.post("/api/accounts/{account_id}/restore")
def restore_account(account_id: int, request: Request):
    return repos(request)["accounts"].set_archived(account_id, False).model_dump()


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
