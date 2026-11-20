from datetime import date

from fastapi import APIRouter, Depends, Request

from moneymap.adapters.sqlite import fx, fx_legacy
from moneymap.dependencies import request_connection
from moneymap.domain.fx import ApplySelection, LegacySelection, Quote, SaveTrade

router = APIRouter(prefix="/api/fx", dependencies=[Depends(request_connection)])


@router.get("")
def report(day: date, request: Request):
    return fx.report(request.state.conn, day)


@router.post("/trades", status_code=201)
def create(body: SaveTrade, request: Request):
    return fx.save(request.state.conn, body)


@router.put("/trades/{trade_id}")
def edit(trade_id: int, body: SaveTrade, request: Request):
    return fx.save(request.state.conn, body, trade_id)


@router.put("/quotes")
def quote(body: Quote, request: Request):
    return fx.set_quote(request.state.conn, body)


@router.get("/legacy")
def candidates(request: Request):
    return fx_legacy.candidates(request.state.conn)


@router.post("/legacy/preview")
def preview(body: LegacySelection, request: Request):
    conn = request.state.conn
    conn.execute("BEGIN")
    return fx_legacy.preview(conn, body)


@router.post("/legacy/apply")
def apply(body: ApplySelection, request: Request):
    return fx_legacy.apply(request.state.conn, body)
