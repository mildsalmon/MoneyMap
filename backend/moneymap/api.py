"""FastAPI composition root. Run: uv run uvicorn moneymap.api:app."""

from __future__ import annotations

import datetime
import os
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite.backup import run_daily_backup
from moneymap.http_errors import install_error_handlers
from moneymap.routers import accounts, reporting, rules, scenarios, status, transactions

DEFAULT_DB = os.environ.get("MONEYMAP_DB", "moneymap.db")
DEFAULT_CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


def _cors_origins() -> list[str]:
    configured = os.environ.get("MONEYMAP_CORS_ORIGINS")
    if configured is None:
        return DEFAULT_CORS_ORIGINS
    return [
        origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()
    ]


def create_app(db_path: str = DEFAULT_DB) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Ephemeral apps still exercise file/WAL semantics with independent connections.
        temporary = (
            TemporaryDirectory(prefix="moneymap-") if db_path == ":memory:" else None
        )
        app.state.db_path = (
            str(Path(temporary.name) / "ledger.db") if temporary else db_path
        )
        try:
            conn = connect(app.state.db_path)
            try:
                init_db(conn)
                if temporary is None:
                    run_daily_backup(
                        conn,
                        Path(db_path).resolve().parent / "backups",
                        datetime.date.today(),
                    )
            finally:
                conn.close()
            yield
        finally:
            if temporary:
                temporary.cleanup()

    app = FastAPI(title="MoneyMap", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_error_handlers(app)
    for feature in (status, accounts, transactions, rules, scenarios, reporting):
        app.include_router(feature.router)
    return app


app = create_app()
