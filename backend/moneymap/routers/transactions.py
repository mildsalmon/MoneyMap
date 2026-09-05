from __future__ import annotations

import datetime


from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from moneymap.adapters.sqlite.transaction_input import SqliteTransactionInputQueries
from moneymap.app_services.transaction_input import last_pair, recent_inputs
from moneymap.domain.transaction_input import LastPair, RecentInput

from moneymap.dependencies import repos, request_connection
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Money,
    Posting,
    Transaction,
)

router = APIRouter(dependencies=[Depends(request_connection)])

MAX_DESCRIPTION_LENGTH = 2_000
MAX_MEMO_LENGTH = 10_000
MAX_POSTINGS = 100
MAX_TRANSACTION_TOTAL = 9_007_199_254_740_991


class PostingIn(BaseModel):
    account_id: int = Field(strict=True, gt=0)
    amount: int = Field(
        strict=True,
        ge=-MAX_TRANSACTION_TOTAL,
        le=MAX_TRANSACTION_TOTAL,
    )  # KRW 정수, +차변/−대변


class TransactionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: datetime.date
    description: str = Field(default="", max_length=MAX_DESCRIPTION_LENGTH)
    memo: str = Field(default="", max_length=MAX_MEMO_LENGTH)
    postings: list[PostingIn] = Field(min_length=2, max_length=MAX_POSTINGS)

    @model_validator(mode="after")
    def _bounded_totals(self) -> "TransactionIn":
        debit = sum(posting.amount for posting in self.postings if posting.amount > 0)
        credit = -sum(posting.amount for posting in self.postings if posting.amount < 0)
        if debit > MAX_TRANSACTION_TOTAL or credit > MAX_TRANSACTION_TOTAL:
            raise ValueError("거래 합계가 허용 범위를 넘습니다")
        return self


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
            memo=body.memo,
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


@router.get("/api/transaction-input/last-pair", response_model=LastPair)
def input_last_pair(request: Request, item: str = Query(...)):
    return last_pair(SqliteTransactionInputQueries(request.state.conn), item)


@router.get("/api/transaction-input/recent", response_model=list[RecentInput])
def input_recent(request: Request, limit: int = Query(5, ge=1, le=20)):
    return recent_inputs(SqliteTransactionInputQueries(request.state.conn), limit)
