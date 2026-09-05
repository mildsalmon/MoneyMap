"""SQLite 연결·스키마·시드.

트리거 enforce 전략 (설계서 T3):
    postings는 행 단위로 INSERT되므로 "행마다 SUM=0 검사"는 정상 입력도
    거부한다. 대신 transactions.posted 플래그를 쓴다 —
      1. 리포지토리가 거래 + postings를 넣는다 (posted=0)
      2. 마지막에 posted=1로 확정 → 이 순간 트리거가 차변=대변·단일통화·
         posting≥2를 검산하고 위반이면 RAISE(ABORT) → 전체 롤백
      3. 확정된 거래의 postings 변조(INSERT/UPDATE/DELETE)도 트리거가 차단
    모든 잔액 조회는 posted=1만 본다 — 부분 쓰기는 잔액에 절대 안 섞인다.
도메인 레이어가 1차 검증(같은 invariant)을 이미 하므로 트리거는 백스톱이다.
"""

from __future__ import annotations

import sqlite3

from .lifecycle_migration import migrate_lifecycle

from moneymap.domain.account import OPENING_BALANCE_ACCOUNT_NAME
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK(type IN ('asset','liability','income','expense','equity')),
  parent_id      INTEGER REFERENCES accounts(id),
  currency       TEXT NOT NULL DEFAULT 'KRW' CHECK(length(currency)=3),
  archived       INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK(is_placeholder IN (0,1)),
  is_system      INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0,1)),
  is_overdraft   INTEGER NOT NULL DEFAULT 0 CHECK(is_overdraft IN (0,1)),
  position       INTEGER NOT NULL CHECK(position > 0),
  version        INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
);

CREATE TABLE IF NOT EXISTS scenarios (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  base_scenario_id INTEGER REFERENCES scenarios(id),
  fork_date        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY,
  scenario_id    INTEGER NOT NULL REFERENCES scenarios(id),
  date           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  source_rule_id INTEGER REFERENCES recurring_rules(id),
  posted         INTEGER NOT NULL DEFAULT 0 CHECK(posted IN (0,1))
);

CREATE TABLE IF NOT EXISTS postings (
  id         INTEGER PRIMARY KEY,
  txn_id     INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount     INTEGER NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'KRW' CHECK(length(currency)=3)
);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id                INTEGER PRIMARY KEY,
  scenario_id       INTEGER NOT NULL REFERENCES scenarios(id),
  description       TEXT NOT NULL DEFAULT '',
  from_account_id   INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id     INTEGER NOT NULL REFERENCES accounts(id),
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'KRW' CHECK(length(currency)=3),
  schedule          TEXT NOT NULL,
  start_date        TEXT NOT NULL,
  end_date          TEXT,
  last_materialized TEXT
);

-- 인덱스 (D11): 모든 잔액 계산이 타는 경로
CREATE INDEX IF NOT EXISTS idx_postings_txn      ON postings(txn_id);
CREATE INDEX IF NOT EXISTS idx_postings_account  ON postings(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_scenario_date ON transactions(scenario_id, date);

-- 트리거 백스톱: posted=1 확정 순간 검산
CREATE TRIGGER IF NOT EXISTS trg_txn_post_check
AFTER UPDATE OF posted ON transactions
WHEN NEW.posted = 1
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM postings WHERE txn_id = NEW.id) < 2
      THEN RAISE(ABORT, 'invariant: 거래에는 posting이 2개 이상 필요')
    WHEN (SELECT COALESCE(SUM(amount), 1) FROM postings WHERE txn_id = NEW.id) != 0
      THEN RAISE(ABORT, 'invariant: 차변=대변 위반 (SUM != 0)')
    WHEN (SELECT COUNT(DISTINCT currency) FROM postings WHERE txn_id = NEW.id) > 1
      THEN RAISE(ABORT, 'invariant: 단일 통화 위반')
  END;
END;

-- 확정된 거래의 postings 변조 차단 (3종)
CREATE TRIGGER IF NOT EXISTS trg_posting_insert_on_posted
BEFORE INSERT ON postings
WHEN (SELECT posted FROM transactions WHERE id = NEW.txn_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'invariant: 확정된 거래의 posting은 추가할 수 없음');
END;

CREATE TRIGGER IF NOT EXISTS trg_posting_update_on_posted
BEFORE UPDATE ON postings
WHEN (SELECT posted FROM transactions WHERE id = OLD.txn_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'invariant: 확정된 거래의 posting은 수정할 수 없음');
END;

CREATE TRIGGER IF NOT EXISTS trg_posting_delete_on_posted
BEFORE DELETE ON postings
WHEN (SELECT posted FROM transactions WHERE id = OLD.txn_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'invariant: 확정된 거래의 posting은 삭제할 수 없음');
END;
"""


# accounts가 이미 존재하는 DB에는 SCHEMA만 실행해도 새 컬럼이 생기지 않는다.
# migration으로 is_overdraft를 추가한 뒤에만 이 trigger 묶음을 설치한다.
OVERDRAFT_TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS trg_account_overdraft_insert_shape
BEFORE INSERT ON accounts
WHEN NEW.is_overdraft = 1
  AND (NEW.type != 'asset' OR NEW.is_system = 1 OR NEW.is_placeholder = 1)
BEGIN
  SELECT RAISE(ABORT, 'overdraft_invalid_account');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_overdraft_update_shape
BEFORE UPDATE OF type, is_system, is_placeholder, is_overdraft ON accounts
WHEN NEW.is_overdraft = 1
BEGIN
  SELECT CASE
    WHEN OLD.is_overdraft = 1 AND NEW.is_placeholder = 1
      THEN RAISE(ABORT, 'overdraft_cannot_be_group')
    WHEN NEW.type != 'asset' OR NEW.is_system = 1 OR NEW.is_placeholder = 1
      THEN RAISE(ABORT, 'overdraft_invalid_account')
    WHEN EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = NEW.id)
      THEN RAISE(ABORT, 'overdraft_requires_leaf')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_account_overdraft_child_insert
BEFORE INSERT ON accounts
WHEN NEW.parent_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM accounts p
    WHERE p.id = NEW.parent_id AND p.is_overdraft = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'overdraft_parent_forbids_children');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_overdraft_child_reparent
BEFORE UPDATE OF parent_id ON accounts
WHEN NEW.parent_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM accounts p
    WHERE p.id = NEW.parent_id AND p.is_overdraft = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'overdraft_parent_forbids_children');
END;
"""


def _next_sibling_position(
    conn: sqlite3.Connection,
    account_type: str,
    parent_id: int | None,
) -> int:
    """같은 유형·부모 범위의 마지막 영속 위치 다음 값을 반환한다."""
    row = conn.execute(
        "SELECT COALESCE(MAX(position), 0) + 1 AS next_position "
        "FROM accounts INDEXED BY idx_accounts_sibling_position "
        "WHERE type=? AND COALESCE(parent_id, -1)=COALESCE(?, -1)",
        (account_type, parent_id),
    ).fetchone()
    return int(row["next_position"])


def _migrate_account_position_version(conn: sqlite3.Connection) -> None:
    """position/version 도입을 하나의 SQLite 트랜잭션으로 완료한다.

    기존 행은 형제 범위 `(type, parent_id)`마다 id 순서로 1..N을 받는다.
    스키마 변경, backfill, 제약 설치, 사후 검증 중 하나라도 실패하면 전체를
    rollback해 애플리케이션이 반쯤 변환된 DB로 시작하지 않게 한다.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(accounts)")}
    position_added = "position" not in cols
    if position_added:
        conn.execute("ALTER TABLE accounts ADD COLUMN position INTEGER")
    if "version" not in cols:
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 "
            "CHECK(version > 0)"
        )

    if position_added:
        rows = conn.execute(
            "SELECT id, type, parent_id FROM accounts "
            "ORDER BY type, COALESCE(parent_id, -1), id"
        ).fetchall()
        sibling_positions: dict[tuple[str, int | None], int] = {}
        updates: list[tuple[int, int]] = []
        for row in rows:
            key = (row["type"], row["parent_id"])
            position = sibling_positions.get(key, 0) + 1
            sibling_positions[key] = position
            updates.append((position, row["id"]))
        if updates:
            conn.executemany(
                "UPDATE accounts SET position=? WHERE id=?",
                updates,
            )
    conn.execute("UPDATE accounts SET version=1 WHERE version IS NULL OR version <= 0")

    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_sibling_position "
        "ON accounts(type, COALESCE(parent_id, -1), position)"
    )
    for statement in (
        "CREATE TRIGGER IF NOT EXISTS trg_account_position_insert "
        "BEFORE INSERT ON accounts WHEN NEW.position IS NULL OR NEW.position <= 0 "
        "BEGIN SELECT RAISE(ABORT, 'account_position_invalid'); END",
        "CREATE TRIGGER IF NOT EXISTS trg_account_position_update "
        "BEFORE UPDATE OF position ON accounts WHEN NEW.position IS NULL OR NEW.position <= 0 "
        "BEGIN SELECT RAISE(ABORT, 'account_position_invalid'); END",
    ):
        conn.execute(statement)

    invalid = conn.execute(
        "SELECT COUNT(*) AS n FROM accounts "
        "WHERE position IS NULL OR position <= 0 OR version <= 0"
    ).fetchone()["n"]
    duplicates = conn.execute(
        "SELECT COUNT(*) AS n FROM ("
        "SELECT 1 FROM accounts GROUP BY type, COALESCE(parent_id, -1), position "
        "HAVING COUNT(*) > 1)"
    ).fetchone()["n"]
    if invalid or duplicates:
        raise sqlite3.IntegrityError("account_position_invariant")


def connect(path: str = ":memory:") -> sqlite3.Connection:
    # The dependency and synchronous handler may use different worker threads.
    # Each request exclusively owns this connection; it is never shared by requests.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _foundation_schema(conn: sqlite3.Connection) -> None:
    """스키마 생성 + 시드 (멱등). 기존 DB에는 가벼운 마이그레이션 적용."""
    _execute_script(conn, SCHEMA)
    # 마이그레이션 (기존 DB): 계정 컬럼 추가
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(accounts)")]
    if "archived" not in cols:  # D23 소프트 삭제
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"
        )
    if "is_placeholder" not in cols:  # D24 그룹(대분류) 계정
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0"
        )
    if "is_system" not in cols:  # 시스템 계정(개시잔액) 명시 플래그
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0"
        )
    if "is_overdraft" not in cols:
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN is_overdraft INTEGER NOT NULL DEFAULT 0 "
            "CHECK(is_overdraft IN (0,1))"
        )
    _migrate_account_position_version(conn)
    _execute_script(conn, OVERDRAFT_TRIGGERS)
    # actual 시나리오 (id=1) 시드
    conn.execute(
        "INSERT OR IGNORE INTO scenarios (id, name, base_scenario_id, fork_date) "
        "VALUES (?, 'actual', NULL, NULL)",
        (ACTUAL_SCENARIO_ID,),
    )
    # 개시잔액 equity 계정 시드 (D4)
    row = conn.execute(
        "SELECT id FROM accounts "
        "WHERE name = ? AND type = 'equity' AND parent_id IS NULL "
        "ORDER BY id LIMIT 1",
        (OPENING_BALANCE_ACCOUNT_NAME,),
    ).fetchone()
    if row is None:
        position = _next_sibling_position(conn, "equity", None)
        conn.execute(
            "INSERT INTO accounts (name, type, is_system, position) "
            "VALUES (?, 'equity', 1, ?)",
            (OPENING_BALANCE_ACCOUNT_NAME, position),
        )
    else:
        conn.execute(
            "UPDATE accounts SET is_system=1, version=version+1 "
            "WHERE id=? AND is_system=0",
            (row["id"],),
        )


def _execute_script(conn: sqlite3.Connection, script: str) -> None:
    """Unlike executescript, preserve the runner's transaction (including DDL)."""
    statement = ""
    for line in script.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            conn.execute(statement)
            statement = ""
    if statement.strip():
        raise ValueError("Incomplete migration SQL")


MIGRATIONS = (_foundation_schema, migrate_lifecycle)


def init_db(conn: sqlite3.Connection) -> None:
    """Adopt legacy schemas, migrate atomically, then enable runtime WAL."""
    from pathlib import Path

    from .backup import run_migration_backup

    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current > len(MIGRATIONS):
        raise RuntimeError("Database schema is newer than this application")
    if conn.in_transaction:
        raise RuntimeError("Migrations require an idle connection")
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    existing = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1"
    ).fetchone()
    if current < len(MIGRATIONS) and existing and path:
        run_migration_backup(
            conn, Path(path).parent / "backups", current, len(MIGRATIONS)
        )
    for version, migrate in enumerate(MIGRATIONS, 1):
        if version <= current:
            continue
        try:
            conn.execute("BEGIN IMMEDIATE")
            # Another startup may have migrated while we waited for the write lock.
            if conn.execute("PRAGMA user_version").fetchone()[0] >= version:
                conn.rollback()
                continue
            migrate(conn)
            conn.execute(f"PRAGMA user_version = {version}")
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    conn.execute("PRAGMA journal_mode = WAL")
