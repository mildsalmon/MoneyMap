#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite.backup import run_import_backup
from moneymap.legacy_import import EXPECTED_SOURCE_HASH, import_legacy_csv


def main() -> None:
    parser = argparse.ArgumentParser(description="MoneyMap 과거 CSV 손실 없는 이관")
    parser.add_argument("source", type=Path)
    parser.add_argument("--db", type=Path, default=Path("moneymap.db"))
    parser.add_argument("--classifications", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    conn = connect(str(args.db))
    try:
        init_db(conn)
        backup = None
        if args.apply:
            backup = run_import_backup(conn, args.db.parent / "backups", EXPECTED_SOURCE_HASH)
        report = import_legacy_csv(
            conn,
            args.source,
            args.classifications,
            apply=args.apply,
        )
        report["backup"] = str(backup) if backup else None
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
