"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import datetime
import sqlite3
from contextlib import contextmanager

from moneymap.domain.errors import (
    DomainConflictError,
    DomainError,
    DomainInvariantError,
    DomainUnavailableError,
    DomainValidationError,
)

_D = datetime.date.fromisoformat


def _iso(d: datetime.date | None) -> str | None:
    return d.isoformat() if d is not None else None


_SQLITE_DOMAIN_ERRORS: dict[str, tuple[type[DomainError], str]] = {
    "cash_account_parent_forbidden": (
        DomainConflictError,
        "현금 부족 계산에서 제외한 뒤 하위 계정을 추가하세요",
    ),
    "cash_account_must_be_leaf": (
        DomainConflictError,
        "현금 부족 계산에는 활성 자산 말단 계정만 포함할 수 있습니다",
    ),
    "cash_account_selected": (
        DomainConflictError,
        "현금 부족 계산에서 제외한 뒤 보관하세요",
    ),
    "overdraft_invalid_account": (
        DomainValidationError,
        "마이너스통장은 실제 자산 leaf 계정에만 설정할 수 있습니다",
    ),
    "overdraft_requires_leaf": (
        DomainConflictError,
        "하위 계정이 있는 계정은 마이너스통장으로 설정할 수 없습니다",
    ),
    "overdraft_parent_forbids_children": (
        DomainConflictError,
        "마이너스통장 계정 아래에는 하위 계정을 만들 수 없습니다",
    ),
    "overdraft_cannot_be_group": (
        DomainConflictError,
        "마이너스통장 설정을 해제한 뒤 그룹으로 변경하세요",
    ),
}


def _translate_integrity_error(exc: sqlite3.IntegrityError) -> DomainError | None:
    message = str(exc)
    if (
        "account_position_invalid" in message
        or "idx_accounts_sibling_position" in message
    ):
        return DomainInvariantError(
            "계정 표시 순서를 저장하지 못했습니다",
            code="account_position_invariant",
        )
    for code, (error_type, user_message) in _SQLITE_DOMAIN_ERRORS.items():
        if code in message:
            return error_type(user_message, code=code)
    return None


def _translate_operational_error(exc: sqlite3.OperationalError) -> DomainError | None:
    if (getattr(exc, "sqlite_errorcode", 0) & 0xFF) in {
        sqlite3.SQLITE_BUSY,
        sqlite3.SQLITE_LOCKED,
    }:
        return DomainUnavailableError(
            "데이터베이스가 사용 중입니다. 잠시 후 다시 시도하세요",
            code="database_busy",
            context={"retryable": True},
        )
    return None


@contextmanager
def _account_write(conn: sqlite3.Connection):
    """계정 쓰기의 BEGIN IMMEDIATE/commit/rollback/오류 번역 경계."""
    if conn.in_transaction:
        raise RuntimeError("Write boundary requires an idle connection")
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield
        conn.commit()
    except DomainError:
        conn.rollback()
        raise
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        translated = _translate_integrity_error(exc)
        if translated is not None:
            raise translated from exc
        raise
    except sqlite3.OperationalError as exc:
        conn.rollback()
        translated = _translate_operational_error(exc)
        if translated is not None:
            raise translated from exc
        raise
    except BaseException:
        conn.rollback()
        raise


class SystemClock:
    def today(self) -> datetime.date:
        return datetime.date.today()
