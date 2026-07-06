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
  is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK(is_placeholder IN (0,1))
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


def connect(path: str = ":memory:") -> sqlite3.Connection:
    # check_same_thread=False: FastAPI가 동기 핸들러를 스레드풀에서 돌리므로
    # 연결이 스레드를 넘나든다. CPython sqlite3는 serialized 모드라 안전하다
    # (v1 = 단일 사용자 localhost 전제).
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """스키마 생성 + 시드 (멱등). 기존 DB에는 가벼운 마이그레이션 적용."""
    conn.executescript(SCHEMA)
    # 마이그레이션 (기존 DB): 계정 컬럼 추가
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(accounts)")]
    if "archived" not in cols:  # D23 소프트 삭제
        conn.execute("ALTER TABLE accounts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
    if "is_placeholder" not in cols:  # D24 그룹(대분류) 계정
        conn.execute("ALTER TABLE accounts ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0")
    # actual 시나리오 (id=1) 시드
    conn.execute(
        "INSERT OR IGNORE INTO scenarios (id, name, base_scenario_id, fork_date) "
        "VALUES (?, 'actual', NULL, NULL)",
        (ACTUAL_SCENARIO_ID,),
    )
    # 개시잔액 equity 계정 시드 (D4)
    row = conn.execute(
        "SELECT id FROM accounts WHERE name = ? AND type = 'equity'",
        (OPENING_BALANCE_ACCOUNT_NAME,),
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO accounts (name, type) VALUES (?, 'equity')",
            (OPENING_BALANCE_ACCOUNT_NAME,),
        )
    conn.commit()
