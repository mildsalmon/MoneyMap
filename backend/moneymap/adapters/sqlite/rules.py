"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import sqlite3

from moneymap.domain.account import OPENING_BALANCE_ACCOUNT_NAME
from moneymap.domain.errors import DomainConflictError, DomainNotFoundError
from moneymap.domain.money import Money
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.schedule import Schedule
from moneymap.domain.services import validate_postable_accounts

from .accounts import SqliteAccountRepository
from .common import _D, _account_write, _iso


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
            self._conn.execute(
                "UPDATE recurring_rules SET description=?, from_account_id=?, to_account_id=?,"
                " amount=?, currency=?, schedule=?, start_date=?, end_date=?"
                " WHERE id=?",
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
                ),
            )
            # Only materialization owns the watermark. An edit may have read the
            # rule before another request materialized it; never restore that old value.
            current = self._conn.execute(
                "SELECT last_materialized FROM recurring_rules WHERE id=?", (rule.id,)
            ).fetchone()
            if current is None:
                raise DomainNotFoundError("규칙이 없습니다", code="rule_not_found")
            rule = rule.model_copy(update={
                "last_materialized": _D(current["last_materialized"])
                if current["last_materialized"] else None,
            })
        return rule

    def find_by_scenario(self, scenario_id: int) -> list[RecurringRule]:
        rows = self._conn.execute(
            "SELECT * FROM recurring_rules WHERE scenario_id=? ORDER BY id",
            (scenario_id,),
        ).fetchall()
        return [
            RecurringRule(
                id=r["id"],
                scenario_id=r["scenario_id"],
                description=r["description"],
                from_account_id=r["from_account_id"],
                to_account_id=r["to_account_id"],
                amount=Money(amount=r["amount"], currency=r["currency"]),
                schedule=Schedule(spec=r["schedule"]),
                start_date=_D(r["start_date"]),
                end_date=_D(r["end_date"]) if r["end_date"] else None,
                last_materialized=_D(r["last_materialized"])
                if r["last_materialized"]
                else None,
            )
            for r in rows
        ]


class SqliteRecurringRuleRepository(ScenarioRuleWriter):
    def save(self, rule):
        with _account_write(self._conn):
            validate_postable_accounts(
                SqliteAccountRepository(self._conn).find_all(),
                [rule.from_account_id, rule.to_account_id],
                for_rule=True,
            )
            return super().save(rule)

    def delete(self, rule_id: int) -> None:
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
                "FROM recurring_rules r WHERE r.id=?",
                (OPENING_BALANCE_ACCOUNT_NAME, rule_id),
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
