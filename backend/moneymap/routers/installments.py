"""HTTP boundary for interest-free installment principal management."""

from fastapi import APIRouter, Depends, Query, Request
from moneymap.dependencies import request_connection
from moneymap.domain.installments import (
    Purchase,
    Allocate,
    UpdatePlan,
    Reschedule,
    Command,
    schedule,
)
from moneymap.adapters.sqlite import installments as store

router = APIRouter(dependencies=[Depends(request_connection)])


@router.get("/api/installments")
def list_plans(request: Request):
    return store.list_plans(request.state.conn)


@router.get("/api/installments/transactions")
def candidate_transactions(request: Request, q: str = Query("", max_length=2000)):
    return store.candidates(request.state.conn, q)


@router.post("/api/installments/preview")
def preview(body: Purchase):
    return {"installments": schedule(body.principal, body.months, body.first_due_date)}


@router.post("/api/installments", status_code=201)
def create(body: Purchase, request: Request):
    return store.create(request.state.conn, body)


@router.put("/api/installments/allocations")
def allocate(body: Allocate, request: Request):
    return store.allocate(request.state.conn, body)


@router.put("/api/installments/rows/{row_id}")
def reschedule(row_id: int, body: Reschedule, request: Request):
    return store.reschedule(request.state.conn, row_id, body)


@router.put("/api/installments/{plan_id}")
def update(plan_id: int, body: UpdatePlan, request: Request):
    return store.update_plan(request.state.conn, plan_id, body)


@router.delete("/api/installments/{plan_id}")
def remove(plan_id: int, body: Command, request: Request):
    return store.remove(request.state.conn, plan_id, body)
