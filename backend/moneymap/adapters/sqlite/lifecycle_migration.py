"""Migration 2: classify existing assumptions without guessing their origin."""

import logging
import sqlite3


def migrate_lifecycle(conn: sqlite3.Connection) -> None:
    for definition in (
        "description TEXT NOT NULL DEFAULT ''",
        "status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived'))",
        "archived_at TEXT",
        "version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)",
        "rule_mode TEXT NOT NULL DEFAULT 'live_additive' CHECK(rule_mode IN ('live_additive','legacy_snapshot'))",
    ):
        conn.execute(f"ALTER TABLE scenarios ADD COLUMN {definition}")
    conn.execute(
        "CREATE TABLE calculation_revisions (id INTEGER PRIMARY KEY CHECK(id=1), actual_ledger_revision INTEGER NOT NULL DEFAULT 1, actual_rule_revision INTEGER NOT NULL DEFAULT 1)"
    )
    conn.execute("INSERT INTO calculation_revisions(id) VALUES(1)")
    conn.execute(
        "CREATE TABLE scenario_id_sequence(id INTEGER PRIMARY KEY CHECK(id=1), next_id INTEGER NOT NULL CHECK(next_id>1))"
    )
    conn.execute(
        "INSERT INTO scenario_id_sequence SELECT 1,coalesce(max(id),1)+1 FROM scenarios"
    )
    for table, column in (
        ("transactions", "actual_ledger_revision"),
        ("recurring_rules", "actual_rule_revision"),
    ):
        for operation in ("INSERT", "UPDATE", "DELETE"):
            guard = (
                "OLD.scenario_id=1" if operation == "DELETE" else "NEW.scenario_id=1"
            )
            if operation == "UPDATE":
                guard += " OR OLD.scenario_id=1"
            conn.execute(
                f"CREATE TRIGGER revision_{table}_{operation.lower()} AFTER {operation} ON {table} WHEN {guard} BEGIN UPDATE calculation_revisions SET {column}={column}+1 WHERE id=1; END"
            )
    # Raw unposted posting edits are also changes to the actual ledger input.
    for operation in ("INSERT", "UPDATE", "DELETE"):
        ref = "OLD" if operation == "DELETE" else "NEW"
        conn.execute(
            f"CREATE TRIGGER revision_postings_{operation.lower()} AFTER {operation} ON postings WHEN EXISTS(SELECT 1 FROM transactions WHERE id={ref}.txn_id AND scenario_id=1) BEGIN UPDATE calculation_revisions SET actual_ledger_revision=actual_ledger_revision+1 WHERE id=1; END"
        )
    conn.execute("CREATE INDEX idx_rules_scenario ON recurring_rules(scenario_id)")
    conn.execute(
        "CREATE INDEX idx_scenarios_status_archive ON scenarios(status, archived_at)"
    )
    actual_rules = conn.execute(
        "SELECT count(*) FROM recurring_rules WHERE scenario_id=1"
    ).fetchone()[0]
    for scenario in conn.execute(
        "SELECT id,fork_date FROM scenarios WHERE id!=1"
    ).fetchall():
        sid = scenario["id"]
        local_rules = conn.execute(
            "SELECT count(*) FROM recurring_rules WHERE scenario_id=?", (sid,)
        ).fetchone()[0]
        generated = conn.execute(
            "SELECT count(*) FROM transactions WHERE scenario_id=? AND source_rule_id IS NOT NULL",
            (sid,),
        ).fetchone()[0]
        conflicts = conn.execute(
            "SELECT count(*) FROM transactions WHERE scenario_id=? AND source_rule_id IS NULL AND date<=?",
            (sid, scenario["fork_date"]),
        ).fetchone()[0]
        logging.getLogger(__name__).info(
            "scenario migration id=%s actual_rules=%s owned_rules=%s generated=%s date_conflicts=%s",
            sid,
            actual_rules,
            local_rules,
            generated,
            conflicts,
        )
        # A date conflict always requires an explicit decision, even without clones.
        if (actual_rules and local_rules) or conflicts:
            conn.execute(
                "UPDATE scenarios SET rule_mode='legacy_snapshot' WHERE id=?", (sid,)
            )
        else:
            conn.execute(
                "UPDATE transactions SET posted=0 WHERE scenario_id=? AND source_rule_id IS NOT NULL",
                (sid,),
            )
            conn.execute(
                "DELETE FROM postings WHERE txn_id IN (SELECT id FROM transactions WHERE scenario_id=? AND source_rule_id IS NOT NULL)",
                (sid,),
            )
            conn.execute(
                "DELETE FROM transactions WHERE scenario_id=? AND source_rule_id IS NOT NULL",
                (sid,),
            )
