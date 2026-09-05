from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, Request

from moneymap.dependencies import repos, request_connection

router = APIRouter(dependencies=[Depends(request_connection)])


@router.get("/api/health")
def health():
    return {"status": "ok"}


@router.get("/api/status")
def status(request: Request):
    """장부 상태 스트립(D8): 검산·백업·마지막 입력."""
    db_path = request.app.state.db_path
    total, last_entry = repos(request)["queries"].status()
    last_backup = None
    if db_path != ":memory:":
        backups = sorted(
            (Path(db_path).resolve().parent / "backups").glob("moneymap-*.db")
        )
        if backups:
            last_backup = backups[-1].stem.removeprefix("moneymap-")
    return {
        "trial_balance_ok": total == 0,
        "last_entry": last_entry,
        "last_backup": last_backup,
    }
