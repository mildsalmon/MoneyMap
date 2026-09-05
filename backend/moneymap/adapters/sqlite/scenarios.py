"""Commit-free scenario aggregate persistence; the application owns transactions."""

from __future__ import annotations

import sqlite3
import datetime as dt

from moneymap.domain.errors import DomainConflictError
from moneymap.domain.scenario import Scenario
from .common import _account_write, _iso


class ScenarioWriter:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def save(self, scenario: Scenario) -> Scenario:
        if not self._conn.in_transaction:
            raise RuntimeError("Scenario writers require an active UnitOfWork")
        if scenario.id is None:
            identity = self._conn.execute(
                "UPDATE scenario_id_sequence SET next_id=max(next_id,(SELECT coalesce(max(id),1)+1 FROM scenarios))+1 WHERE id=1 RETURNING next_id-1"
            ).fetchone()[0]
            cur = self._conn.execute(
                "INSERT INTO scenarios(id,name,base_scenario_id,fork_date,description,rule_mode) VALUES(?,?,?,?,?,?)",
                (
                    identity,
                    scenario.name,
                    scenario.base_scenario_id,
                    _iso(scenario.fork_date),
                    scenario.description,
                    scenario.rule_mode,
                ),
            )
            return self.find_by_id(cur.lastrowid)
        cur = self._conn.execute(
            "UPDATE scenarios SET name=?,description=?,status=?,archived_at=?,rule_mode=?,version=? WHERE id=? AND version=?",
            (
                scenario.name,
                scenario.description,
                scenario.status,
                _iso(scenario.archived_at),
                scenario.rule_mode,
                scenario.version,
                scenario.id,
                scenario.version - 1,
            ),
        )
        if cur.rowcount != 1:
            raise DomainConflictError(
                "최신 내용을 확인하세요", code="scenario_version_conflict"
            )
        return self.find_by_id(scenario.id)

    @staticmethod
    def _row_to_scenario(row: sqlite3.Row) -> Scenario:
        values = dict(row)
        for key in ("created_at", "archived_at"):
            if values.get(key):
                timestamp = dt.datetime.fromisoformat(values[key])
                values[key] = (
                    timestamp
                    if timestamp.tzinfo
                    else timestamp.replace(tzinfo=dt.timezone.utc)
                )
        return Scenario.model_validate(values)

    def find_by_id(self, scenario_id: int) -> Scenario | None:
        row = self._conn.execute(
            "SELECT * FROM scenarios WHERE id=?", (scenario_id,)
        ).fetchone()
        return self._row_to_scenario(row) if row else None

    def list_all(self, status: str | None = None) -> list[Scenario]:
        if status is None:
            rows = self._conn.execute("SELECT * FROM scenarios ORDER BY id").fetchall()
        else:
            order = "created_at" if status == "active" else "archived_at"
            rows = self._conn.execute(
                f"SELECT * FROM scenarios WHERE id!=1 AND status=? ORDER BY {order} DESC,id DESC",
                (status,),
            ).fetchall()
        return [self._row_to_scenario(r) for r in rows]

    def impact(self, scenario: Scenario) -> dict:
        row = self._conn.execute(
            "SELECT (SELECT count(*) FROM recurring_rules WHERE scenario_id=?) rules,"
            "sum(CASE WHEN source_rule_id IS NULL THEN 1 ELSE 0 END) planned_transactions,"
            "sum(CASE WHEN source_rule_id IS NOT NULL THEN 1 ELSE 0 END) generated_transactions,"
            "(SELECT count(*) FROM postings p JOIN transactions t ON t.id=p.txn_id WHERE t.scenario_id=?) postings "
            "FROM transactions WHERE scenario_id=?",
            (scenario.id, scenario.id, scenario.id),
        ).fetchone()
        return {
            "scenario_id": scenario.id,
            "name": scenario.name,
            "version": scenario.version,
            **{k: row[k] or 0 for k in row.keys()},
        }

    def transaction_summaries(self, sid: int) -> list[dict]:
        return [
            dict(r)
            for r in self._conn.execute(
                "SELECT id,date,description,source_rule_id FROM transactions WHERE scenario_id=? ORDER BY date,id",
                (sid,),
            )
        ]

    def remove_transactions(self, sid: int, ids: list[int] | None = None) -> None:
        if ids == []:
            return
        clause = "scenario_id=?"
        params: list = [sid]
        if ids is not None:
            clause += " AND id IN (" + ",".join("?" for _ in ids) + ")"
            params += ids
        self._conn.execute(f"UPDATE transactions SET posted=0 WHERE {clause}", params)
        self._conn.execute(
            f"DELETE FROM postings WHERE txn_id IN (SELECT id FROM transactions WHERE {clause})",
            params,
        )
        self._conn.execute(f"DELETE FROM transactions WHERE {clause}", params)

    def move_transaction(self, sid: int, tid: int, date) -> None:
        self._conn.execute(
            "UPDATE transactions SET date=? WHERE id=? AND scenario_id=?",
            (_iso(date), tid, sid),
        )

    def delete(self, sid: int) -> None:
        self.remove_transactions(sid)
        self._conn.execute("DELETE FROM recurring_rules WHERE scenario_id=?", (sid,))
        self._conn.execute("DELETE FROM scenarios WHERE id=?", (sid,))


class SqliteScenarioRepository(ScenarioWriter):
    def save(self, scenario):
        with _account_write(self._conn):
            return super().save(scenario)
