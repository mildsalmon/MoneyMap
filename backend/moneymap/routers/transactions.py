from __future__ import annotations

import datetime


from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, ValidationError

from moneymap.dependencies import repos, request_connection
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Money,
    Posting,
    Transaction,
)

router = APIRouter(dependencies=[Depends(request_connection)])


class PostingIn(BaseModel):
    account_id: int
    amount: int  # KRW 정수, +차변/−대변


class TransactionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: datetime.date
    description: str = ""
    postings: list[PostingIn]


@router.get("/api/opening-balances")
def list_opening_balances(request: Request):
    return repos(request)["txns"].find_opening_balances()


@router.get("/api/transactions")
def list_transactions(
    request: Request, scenario_id: int = Query(default=1, ge=1, le=1)
):
    return [
        t.model_dump() for t in repos(request)["txns"].find_by_scenario(scenario_id)
    ]


@router.post("/api/transactions", status_code=201)
def create_transaction(body: TransactionIn, request: Request):
    try:
        txn = Transaction(
            scenario_id=ACTUAL_SCENARIO_ID,
            date=body.date,
            description=body.description,
            postings=[
                Posting(account_id=p.account_id, amount=Money(amount=p.amount))
                for p in body.postings
            ],
        )
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    saved = repos(request)["txns"].save(txn)
    return saved.model_dump()


@router.delete("/api/transactions/{txn_id}")
def delete_transaction(txn_id: int, request: Request):
    ok = repos(request)["txns"].delete(txn_id, scenario_id=ACTUAL_SCENARIO_ID)
    if not ok:
        raise HTTPException(
            status_code=404,
            detail={"code": "transaction_not_found", "message": "거래가 없습니다"},
        )
    return {"deleted": txn_id}
