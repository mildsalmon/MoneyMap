"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import datetime
import sqlite3

from moneymap.domain import ACTUAL_SCENARIO_ID
from moneymap.domain.materialize import plan_materialization

from .common import _account_write, _iso
from .rules import SqliteRecurringRuleRepository
from .transactions import _insert_txn


def apply_materialization(conn: sqlite3.Connection, plan) -> list[int]:
    """MaterializationPlan을 단일 SQL 트랜잭션으로 적용한다 (D9 원자성).

    거래 생성 전부 + 규칙 watermark(last_materialized) 갱신이 한 덩어리 —
    도중에 죽으면 전부 롤백되고 다음 실행이 같은 계획을 다시 세운다.

    동시 실행 방어 (낙관적 잠금): watermark를 '계획 수립 시점 값과 같을 때만'
    조건부 UPDATE로 먼저 선점한다. 다른 실행이 이미 적용했다면 rowcount=0 →
    전체 롤백하고 빈 목록 반환. 두 클라이언트가 같은 계획을 동시에 적용해도
    이중 기입은 구조적으로 불가능하다.

    반환: 생성된 거래 id 목록 (선점 실패 시 []).
    """
    try:
        with _account_write(conn):
            return _apply_materialization(conn, plan)
    except _StaleMaterialization:
        return []


class _StaleMaterialization(Exception):
    pass


def _apply_materialization(conn: sqlite3.Connection, plan) -> list[int]:
    """Apply inside the caller's write transaction without committing it."""
    if not conn.in_transaction:
        raise RuntimeError("Materialization requires an active write transaction")
    for rule_id, watermark in plan.watermarks.items():
        cur = conn.execute(
            "UPDATE recurring_rules SET last_materialized=?"
            " WHERE id=? AND last_materialized IS ?",
            (_iso(watermark), rule_id, _iso(plan.expected.get(rule_id))),
        )
        if cur.rowcount == 0:
            raise _StaleMaterialization()
    return [_insert_txn(conn, txn) for txn in plan.transactions]


def materialize_actual(conn: sqlite3.Connection, today: datetime.date):
    """Reserve the writer before reading rules so edits cannot stale the plan."""
    with _account_write(conn):
        rules = SqliteRecurringRuleRepository(conn).find_by_scenario(ACTUAL_SCENARIO_ID)
        plan = plan_materialization(rules, today=today)
        ids = _apply_materialization(conn, plan)
        return ids, plan
