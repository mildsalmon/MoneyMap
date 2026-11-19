from fastapi import APIRouter, Depends, Request

from moneymap.adapters.sqlite import reconciliation
from moneymap.dependencies import request_connection
from moneymap.domain.reconciliation import Adjustment, Statement

router = APIRouter(prefix="/api/reconciliation", dependencies=[Depends(request_connection)])


@router.post("/preview")
def preview(body: Statement, request: Request):
    return reconciliation.preview(request.state.conn, body)


@router.post("/confirm")
def confirm(body: Adjustment, request: Request):
    return reconciliation.confirm(request.state.conn, body)
