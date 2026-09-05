"""Application errors use one envelope; FastAPI request validation stays native."""

import sqlite3

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException

from moneymap.adapters.sqlite.common import (
    _translate_integrity_error,
    _translate_operational_error,
)
from moneymap.domain.errors import (
    DomainError,
    DomainInvariantError,
    DomainValidationError,
)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def domain_error(request: Request, exc: DomainError):
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": {
                    **exc.context,
                    "code": exc.code,
                    "message": exc.message,
                }
            },
        )

    @app.exception_handler(ValidationError)
    async def model_validation_error(request: Request, exc: ValidationError):
        error = DomainValidationError(
            "입력 값을 확인하세요",
            context={"errors": jsonable_encoder(exc.errors(include_context=False))},
        )
        return await domain_error(request, error)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        detail = exc.detail
        if not isinstance(detail, dict):
            detail = {
                "code": {404: "not_found", 405: "method_not_allowed"}.get(
                    exc.status_code, "validation_error"
                ),
                "message": str(detail),
            }
        return JSONResponse(
            status_code=exc.status_code, content={"detail": detail}, headers=exc.headers
        )

    @app.exception_handler(sqlite3.OperationalError)
    async def operational_error(request: Request, exc: sqlite3.OperationalError):
        error = _translate_operational_error(exc) or DomainInvariantError(
            "데이터베이스 작업을 완료하지 못했습니다", code="database_error"
        )
        return await domain_error(request, error)

    @app.exception_handler(sqlite3.IntegrityError)
    async def integrity_error(request: Request, exc: sqlite3.IntegrityError):
        error = _translate_integrity_error(exc) or DomainValidationError(
            "저장 데이터의 제약 조건을 확인하세요", code="database_constraint"
        )
        return await domain_error(request, error)
