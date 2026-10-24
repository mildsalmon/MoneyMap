"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import hashlib
import sqlite3

from moneymap.domain.account import OPENING_BALANCE_ACCOUNT_NAME
from moneymap.domain.errors import DomainConflictError, DomainNotFoundError, DomainValidationError
from moneymap.domain.money import Money
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.schedule import Schedule
from moneymap.domain.services import validate_postable_accounts

from .accounts import SqliteAccountRepository
from .common import _D, _account_write, _iso


def rule_edit_token(rule: RecurringRule) -> str:
    """A strong snapshot validator, including the materialization watermark."""
    digest = hashlib.sha256(rule.model_dump_json().encode()).hexdigest()
    return f'"{digest}"'


def _rule_from_row(row: sqlite3.Row) -> RecurringRule:
    return RecurringRule(
        id=row["id"],
        scenario_id=row["scenario_id"],
        description=row["description"],
        from_account_id=row["from_account_id"],
        to_account_id=row["to_account_id"],
        amount=Money(amount=row["amount"], currency=row["currency"]),
        schedule=Schedule(spec=row["schedule"]),
        start_date=_D(row["start_date"]),
        end_date=_D(row["end_date"]) if row["end_date"] else None,
        last_materialized=_D(row["last_materialized"])
        if row["last_materialized"]
        else None,
    )


class ScenarioRuleWriter:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, rule: RecurringRule) -> RecurringRule:
        if not self._conn.in_transaction:
            raise RuntimeError("Scenario writers require an active UnitOfWork")
        if rule.id is None:
            cur = self._conn.execute(
                "INSERT INTO recurring_rules "
                "(scenario_id, description, from_account_id, to_account_id, amount, currency,"
                " schedule, start_date, end_date, last_materialized) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    rule.scenario_id,
                    rule.description,
                    rule.from_account_id,
                    rule.to_account_id,
                    rule.amount.amount,
                    rule.amount.currency,
                    rule.schedule.spec,
                    _iso(rule.start_date),
                    _iso(rule.end_date),
                    _iso(rule.last_materialized),
                ),
            )
            rule = rule.model_copy(update={"id": cur.lastrowid})
        else:
            updated = self._conn.execute(
                "UPDATE recurring_rules SET description=?, from_account_id=?, to_account_id=?,"
                " amount=?, currency=?, schedule=?, start_date=?, end_date=?"
                " WHERE id=? AND scenario_id=?",
                (
                    rule.description,
                    rule.from_account_id,
                    rule.to_account_id,
                    rule.amount.amount,
                    rule.amount.currency,
                    rule.schedule.spec,
                    _iso(rule.start_date),
                    _iso(rule.end_date),
                    rule.id,
                    rule.scenario_id,
                ),
            )
            if updated.rowcount != 1:
                raise DomainNotFoundError("규칙이 없습니다", code="rule_not_found")
            # Only materialization owns the watermark. An edit may have read the
            # rule before another request materialized it; never restore that old value.
            current = self._conn.execute(
                "SELECT last_materialized FROM recurring_rules WHERE id=?", (rule.id,)
            ).fetchone()
            if current is None:
                raise DomainNotFoundError("규칙이 없습니다", code="rule_not_found")
            rule = rule.model_copy(
                update={
                    "last_materialized": _D(current["last_materialized"])
                    if current["last_materialized"]
                    else None,
                }
            )
        return rule

    def delete_owned(self, rule_id: int, scenario_id: int) -> None:
        if not self._conn.in_transaction:
            raise RuntimeError("Scenario writers require an active UnitOfWork")
        self._conn.execute(
            "UPDATE transactions SET source_rule_id=NULL WHERE source_rule_id=? AND scenario_id=?",
            (rule_id, scenario_id),
        )
        self._conn.execute(
            "DELETE FROM recurring_rules WHERE id=? AND scenario_id=?",
            (rule_id, scenario_id),
        )

    def find_by_scenario(self, scenario_id: int) -> list[RecurringRule]:
        rows = self._conn.execute(
            "SELECT * FROM recurring_rules WHERE scenario_id=? ORDER BY id",
            (scenario_id,),
        ).fetchall()
        return [_rule_from_row(row) for row in rows]


class SqliteRecurringRuleRepository(ScenarioRuleWriter):
    def save(self, rule, *, expected_token: str | None = None):
        with _account_write(self._conn):
            if expected_token is not None:
                row = self._conn.execute(
                    "SELECT * FROM recurring_rules WHERE id=? AND scenario_id=?",
                    (rule.id, rule.scenario_id),
                ).fetchone()
                if row is None:
                    raise DomainNotFoundError("규칙이 없습니다", code="rule_not_found")
                current = _rule_from_row(row)
                if rule_edit_token(current) != expected_token:
                    raise DomainConflictError(
                        "규칙 또는 마지막 처리일이 변경되었습니다. 최신 내용을 확인하세요",
                        code="rule_edit_conflict",
                    )
            accounts = SqliteAccountRepository(self._conn).find_all()
            validate_postable_accounts(
                accounts, [rule.from_account_id, rule.to_account_id], for_rule=True,
            )
            for account in accounts:
                if account.id not in {rule.from_account_id, rule.to_account_id}:
                    continue
                if account.archived or account.currency != rule.amount.currency:
                    raise DomainValidationError(
                        "보관된 계정 또는 규칙과 통화가 다른 계정은 사용할 수 없습니다",
                        code="rule_account_unavailable",
                        context={"account_id": account.id},
                    )
            return super().save(rule)

    def delete(self, rule_id: int, *, scenario_id: int | None = None) -> None:
        conn = self._conn
        with _account_write(conn):
            legacy = conn.execute(
                "SELECT EXISTS ("
                "  SELECT 1 FROM transactions t "
                "  JOIN postings p ON p.txn_id=t.id "
                "  JOIN accounts a ON a.id=p.account_id "
                "  WHERE t.source_rule_id=r.id "
                "    AND a.is_system=1 AND a.type='equity' AND a.name=?"
                ") AS generated_opening "
                "FROM recurring_rules r WHERE r.id=? AND (? IS NULL OR r.scenario_id=?)",
                (OPENING_BALANCE_ACCOUNT_NAME, rule_id, scenario_id, scenario_id),
            ).fetchone()
            if legacy is None:
                raise DomainNotFoundError("규칙이 없습니다", code="rule_not_found")
            if legacy["generated_opening"]:
                raise DomainConflictError(
                    "시스템 계정 규칙의 자동 생성 거래를 먼저 삭제하세요",
                    code="system_rule_has_materialized_transactions",
                )
            conn.execute(
                "UPDATE transactions SET source_rule_id=NULL WHERE source_rule_id=?",
                (rule_id,),
            )
            conn.execute("DELETE FROM recurring_rules WHERE id=?", (rule_id,))
