from __future__ import annotations

import datetime


from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from moneymap.adapters.sqlite.transaction_input import SqliteTransactionInputQueries
from moneymap.app_services.transaction_input import last_pair, recent_inputs
from moneymap.domain.transaction_input import LastPair, RecentInput
from moneymap.domain.transaction_edit import TransactionEdit
from moneymap.domain.errors import DomainNotFoundError

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
MAX_TAGS = 20
MAX_TAG_LENGTH = 50
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
    tags: list[str] = Field(default_factory=list, max_length=MAX_TAGS)
    postings: list[PostingIn] = Field(min_length=2, max_length=MAX_POSTINGS)

    @model_validator(mode="after")
    def _bounded_totals(self) -> "TransactionIn":
        if any(not tag.strip() or len(tag.strip()) > MAX_TAG_LENGTH for tag in self.tags):
            raise ValueError("태그는 공백이 아닌 50자 이하 문자열이어야 합니다")
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


@router.get("/api/tags")
def list_tags(request: Request):
    return [
        row["name"]
        for row in request.state.conn.execute(
            "SELECT name FROM tags ORDER BY name_key"
        )
    ]


@router.post("/api/transactions", status_code=201)
def create_transaction(body: TransactionIn, request: Request):
    try:
        txn = Transaction(
            scenario_id=ACTUAL_SCENARIO_ID,
            date=body.date,
            description=body.description,
            memo=body.memo,
            tags=body.tags,
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


@router.get("/api/transactions/{txn_id}")
def get_transaction(txn_id: int, request: Request):
    detail = repos(request)["txns"].find_edit_detail(txn_id)
    if detail is None:
        raise DomainNotFoundError("거래가 없습니다", code="transaction_not_found")
    return detail.model_dump(mode="json")


@router.put("/api/transactions/{txn_id}")
def edit_transaction(txn_id: int, body: TransactionEdit, request: Request):
    return repos(request)["txns"].update(txn_id, body)


@router.post("/api/transactions/{txn_id}/edit-result")
def resolve_transaction_edit(txn_id: int, body: TransactionEdit, request: Request):
    return repos(request)["txns"].resolve_edit(txn_id, body)


@router.get("/api/transaction-input/last-pair", response_model=LastPair)
def input_last_pair(request: Request, item: str = Query(...)):
    return last_pair(SqliteTransactionInputQueries(request.state.conn), item)


@router.get("/api/transaction-input/recent", response_model=list[RecentInput])
def input_recent(request: Request, limit: int = Query(5, ge=1, le=20)):
    return recent_inputs(SqliteTransactionInputQueries(request.state.conn), limit)
