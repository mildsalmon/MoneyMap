"""Reproducible projection benchmark, including a PR1 baseline compatibility path.

Fixture construction is excluded. SQL count includes read transaction boundaries.
The old response and new response are labeled explicitly in the artifact.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import platform
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from moneymap.adapters.sqlite import connect, init_db
from moneymap.api import create_app

FORK = dt.date(2026, 1, 31)


def fixture(path):
    conn = connect(str(path))
    init_db(conn)
    with conn:
        for aid in range(2, 251):
            kind = "asset" if aid < 127 else "income" if aid < 227 else "expense"
            conn.execute(
                "INSERT INTO accounts(id,name,type,position) VALUES(?,?,?,?)",
                (aid, f"account-{aid}", kind, aid),
            )
        conn.execute(
            "INSERT INTO scenarios(id,name,base_scenario_id,fork_date) VALUES(2,'benchmark',1,?)",
            (FORK.isoformat(),),
        )
        txns = [
            (tid, 1, (dt.date(2025, 1, 1) + dt.timedelta(days=tid % 365)).isoformat())
            for tid in range(1, 50001)
        ]
        txns += [
            (50001 + i, 2, (FORK + dt.timedelta(days=1 + i % 365)).isoformat())
            for i in range(500)
        ]
        conn.executemany(
            "INSERT INTO transactions(id,scenario_id,date) VALUES(?,?,?)", txns
        )
        conn.executemany(
            "INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)",
            (
                (tid, account, amount)
                for tid, sid, _ in txns
                for account, amount in (
                    (2, 1000 if sid == 1 else -100),
                    (127 if sid == 1 else 227, -1000 if sid == 1 else 100),
                )
            ),
        )
        conn.execute("UPDATE transactions SET posted=1")
        conn.executemany(
            "INSERT INTO recurring_rules(scenario_id,from_account_id,to_account_id,amount,schedule,start_date) VALUES(?,?,?,?,?,?)",
            [
                (
                    1 if i < 200 else 2,
                    127 if i < 200 else 2,
                    2 if i < 200 else 227,
                    1000,
                    "monthly:25",
                    "2025-01-01",
                )
                for i in range(300)
            ],
        )
    return conn


def measure(operation, warmups, samples):
    for _ in range(warmups):
        operation()
    times = []
    for _ in range(samples):
        start = time.perf_counter()
        operation()
        times.append((time.perf_counter() - start) * 1000)
    return {"samples_ms": times, "p95_ms": sorted(times)[math.ceil(samples * 0.95) - 1]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--warmups", type=int, default=5)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--months", type=int, choices=[3, 6, 12], default=12)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--enforce-reference", action="store_true")
    args = parser.parse_args()
    if args.samples < 1 or args.warmups < 0:
        parser.error("samples >= 1 and warmups >= 0 required")
    with tempfile.TemporaryDirectory(prefix="projection-benchmark-") as tmp:
        path = Path(tmp) / "ledger.db"
        conn = fixture(path)
        modern = (
            Path(__file__).resolve().parents[1] / "moneymap/domain/projection.py"
        ).exists()
        if modern:
            from moneymap.adapters.sqlite.projection import ProjectionInputReader
            from moneymap.app_services.projection import build_projection

            def service():
                conn.execute("BEGIN")
                try:
                    return build_projection(ProjectionInputReader(conn), 2, args.months)
                finally:
                    conn.rollback()

            url = f"/api/projection?scenario_id=2&months={args.months}"
        else:
            from moneymap import app_services
            from moneymap.adapters.sqlite import (
                SqliteAccountRepository,
                SqliteTransactionRepository,
                SqliteRecurringRuleRepository,
                SqliteScenarioRepository,
                SqliteLedgerQueries,
            )

            def service():
                conn.execute("BEGIN")
                try:
                    queries = SqliteLedgerQueries(conn)
                    return app_services.build_projection(
                        accounts=SqliteAccountRepository(conn).find_all(),
                        txn_repo=SqliteTransactionRepository(conn),
                        rule_repo=SqliteRecurringRuleRepository(conn),
                        scenario_repo=SqliteScenarioRepository(conn),
                        net_worth_at=queries.net_worth_at,
                        actual_base_net_worth=queries.actual_base_net_worth,
                        today=FORK,
                        months=args.months,
                        scenario_ids=[2],
                    )
                finally:
                    conn.rollback()

            url = f"/api/projection?scenario_ids=2&months={args.months}"
        statements = []
        conn.set_trace_callback(statements.append)
        service()
        conn.set_trace_callback(None)
        service_result = measure(service, args.warmups, args.samples)
        with TestClient(create_app(str(path))) as client:

            def api():
                response = client.get(url)
                response.raise_for_status()
                return response.json()

            from moneymap import dependencies

            api_statements = []
            original_connect = dependencies.connect

            def traced_connect(*args, **kwargs):
                connection = original_connect(*args, **kwargs)
                connection.set_trace_callback(api_statements.append)
                return connection

            with patch.object(dependencies, "connect", traced_connect):
                api()
            api_result = measure(api, args.warmups, args.samples)
        conn.close()
    result = {
        "contract": "PR2 net-worth + monthly"
        if modern
        else "PR1 historical + baseline + snapshot",
        "warmups": args.warmups,
        "samples": args.samples,
        "months": args.months,
        "fixture": {
            "accounts": 250,
            "actual_transactions": 50000,
            "actual_rules": 200,
            "scenario_rules": 100,
            "planned_transactions": 500,
        },
        "environment": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "sqlite": sqlite3.sqlite_version,
        },
        "sql_statements": len(statements),
        "api_sql_statements": len(api_statements),
        "service": service_result,
        "api": api_result,
    }
    encoded = json.dumps(result, indent=2)
    print(encoded)
    if args.output:
        args.output.write_text(encoded + "\n")
    if modern and max(len(statements), len(api_statements)) > 15:
        raise SystemExit("SQL statement budget exceeded")
    if (
        modern
        and args.enforce_reference
        and (service_result["p95_ms"] > 300 or api_result["p95_ms"] > 500)
    ):
        raise SystemExit("Reference time budget exceeded")


if __name__ == "__main__":
    main()
