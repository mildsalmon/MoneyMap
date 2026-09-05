"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import sqlite3

from moneymap.domain.scenario import Scenario

from .common import _D, _account_write, _iso


class ScenarioWriter:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, scenario: Scenario) -> Scenario:
        if not self._conn.in_transaction:
            raise RuntimeError("Scenario writers require an active UnitOfWork")
        if scenario.id is None:
            cur = self._conn.execute(
                "INSERT INTO scenarios (name, base_scenario_id, fork_date) VALUES (?,?,?)",
                (scenario.name, scenario.base_scenario_id, _iso(scenario.fork_date)),
            )
            scenario = scenario.model_copy(update={"id": cur.lastrowid})
        else:
            self._conn.execute(
                "UPDATE scenarios SET name=? WHERE id=?", (scenario.name, scenario.id)
            )
        return scenario

    @staticmethod
    def _row_to_scenario(row: sqlite3.Row) -> Scenario:
        return Scenario(
            id=row["id"],
            name=row["name"],
            base_scenario_id=row["base_scenario_id"],
            fork_date=_D(row["fork_date"]) if row["fork_date"] else None,
        )

    def find_by_id(self, scenario_id: int) -> Scenario | None:
        row = self._conn.execute(
            "SELECT * FROM scenarios WHERE id=?", (scenario_id,)
        ).fetchone()
        return self._row_to_scenario(row) if row else None

    def list_all(self) -> list[Scenario]:
        rows = self._conn.execute("SELECT * FROM scenarios ORDER BY id").fetchall()
        return [self._row_to_scenario(r) for r in rows]


class SqliteScenarioRepository(ScenarioWriter):
    def save(self, scenario):
        with _account_write(self._conn):
            return super().save(scenario)
