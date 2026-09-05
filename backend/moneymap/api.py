"""FastAPI composition root. Run: uv run uvicorn moneymap.api:app."""

from __future__ import annotations

import datetime
import os
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite.backup import run_daily_backup
from moneymap.http_errors import install_error_handlers
from moneymap.routers import accounts, reporting, rules, scenarios, status, transactions

DEFAULT_DB = os.environ.get("MONEYMAP_DB", "moneymap.db")
DEFAULT_CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
MAX_TRANSACTION_BODY_BYTES = 64 * 1024


class TransactionBodyLimitMiddleware:
    """Reject oversized transaction commands before request-body parsing."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not (
            scope["type"] == "http"
            and scope.get("method") == "POST"
            and scope.get("path") == "/api/transactions"
        ):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        try:
            content_length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            content_length = 0
        if content_length > self.max_bytes:
            await self._reject(scope, receive, send)
            return

        chunks: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            total += len(body)
            if total > self.max_bytes:
                await self._reject(scope, receive, send)
                return
            chunks.append(body)
            if not message.get("more_body", False):
                break

        buffered = b"".join(chunks)
        delivered = False

        async def replay() -> dict:
            nonlocal delivered
            if delivered:
                return await receive()
            delivered = True
            return {"type": "http.request", "body": buffered, "more_body": False}

        await self.app(scope, replay, send)

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            status_code=413,
            content={
                "detail": {
                    "code": "request_too_large",
                    "message": "거래 입력이 너무 큽니다",
                }
            },
        )
        await response(scope, receive, send)


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
        TransactionBodyLimitMiddleware,
        max_bytes=MAX_TRANSACTION_BODY_BYTES,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["ETag"],
    )
    install_error_handlers(app)
    for feature in (status, accounts, transactions, rules, scenarios, reporting):
        app.include_router(feature.router)
    return app


app = create_app()
