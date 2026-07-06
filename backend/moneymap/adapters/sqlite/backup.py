"""자동 백업 (D6) — 단일 SQLite 파일이 이 시스템의 유일한 단일 장애점이다.

앱 시작 시 호출: 하루 1회 `backups/moneymap-YYYY-MM-DD.db`를 만들고
최근 keep개만 남긴다. sqlite3의 온라인 백업 API를 쓰므로 사용 중인
DB에도 안전하다. 최악의 경우에도 어제자로 돌아간다.
"""

from __future__ import annotations

import datetime
import sqlite3
from pathlib import Path

BACKUP_PREFIX = "moneymap-"
DEFAULT_KEEP = 30


def run_daily_backup(
    src: sqlite3.Connection,
    backup_dir: Path,
    today: datetime.date,
    keep: int = DEFAULT_KEEP,
) -> Path | None:
    """하루 1회 백업. 오늘자가 이미 있으면 아무것도 안 하고 None.

    반환: 새로 만든 백업 파일 경로 (스킵 시 None).
    """
    backup_dir.mkdir(parents=True, exist_ok=True)
    dest_path = backup_dir / f"{BACKUP_PREFIX}{today.isoformat()}.db"
    if dest_path.exists():
        return None

    dest = sqlite3.connect(dest_path)
    try:
        src.backup(dest)  # 온라인 백업 — 진행 중 쓰기와도 안전
    finally:
        dest.close()

    _rotate(backup_dir, keep)
    return dest_path


def _rotate(backup_dir: Path, keep: int) -> None:
    """이름의 날짜 역순으로 최근 keep개만 남긴다 (ISO 날짜라 문자열 정렬 = 시간 정렬)."""
    backups = sorted(backup_dir.glob(f"{BACKUP_PREFIX}*.db"), reverse=True)
    for old in backups[keep:]:
        old.unlink()
