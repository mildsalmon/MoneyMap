"""Account state at Seoul day close. The journal and its clock use UTC milliseconds."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, time, timezone
from itertools import groupby
import json
import sqlite3
from uuid import uuid4
from zoneinfo import ZoneInfo

from moneymap.domain.errors import DomainConflictError, DomainNotFoundError, DomainValidationError
from .common import _account_write

SEOUL = ZoneInfo("Asia/Seoul")
NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
FIELDS = ("archived", "is_placeholder", "parent_id", "is_system", "is_overdraft", "include_in_cash", "name", "type", "currency")


def _snapshot(prefix: str) -> str:
    return "json_object(" + ",".join(f"'{field}',{prefix}.{field}" for field in FIELDS) + ")"


def migrate_account_history(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE account_history_start (started_at TEXT NOT NULL)")
    conn.execute(f"INSERT INTO account_history_start VALUES ({NOW})")
    conn.execute("""CREATE TABLE account_state_events (
        seq INTEGER PRIMARY KEY, batch TEXT NOT NULL, account_id INTEGER NOT NULL,
        action TEXT NOT NULL, before_state TEXT, after_state TEXT NOT NULL,
        recorded_at TEXT NOT NULL, effective_at TEXT NOT NULL)""")
    conn.execute("CREATE INDEX account_event_batch ON account_state_events(batch, seq)")
    conn.execute("""CREATE TABLE account_date_corrections (
        revision INTEGER PRIMARY KEY, batch TEXT NOT NULL, previous_at TEXT NOT NULL,
        effective_at TEXT NOT NULL, recorded_at TEXT NOT NULL)""")
    conn.execute("CREATE INDEX account_correction_batch ON account_date_corrections(batch, revision)")
    # Only populated within a writer's BEGIN IMMEDIATE. Raw imports also log,
    # using a fresh batch per statement row when no multi-row action is open.
    conn.execute("CREATE TABLE account_action_context (batch TEXT PRIMARY KEY, effective_at TEXT)")
    conn.execute(f"""INSERT INTO account_state_events
        SELECT NULL, lower(hex(randomblob(16))), a.id, 'baseline', NULL, {_snapshot('a')},
               started_at, started_at FROM accounts a CROSS JOIN account_history_start ORDER BY a.id""")
    for table in ("account_state_events", "account_date_corrections", "account_history_start"):
        for operation in ("UPDATE", "DELETE"):
            conn.execute(f"""CREATE TRIGGER {table}_no_{operation.lower()} BEFORE {operation} ON {table}
                BEGIN SELECT RAISE(ABORT,'account history is append-only'); END""")
    batch = "coalesce((SELECT batch FROM account_action_context), lower(hex(randomblob(16))))"
    effective = f"coalesce((SELECT effective_at FROM account_action_context), {NOW})"
    action = """CASE WHEN OLD.archived != NEW.archived THEN
                         CASE WHEN NEW.archived THEN 'archive' ELSE 'restore' END
                     WHEN OLD.parent_id IS NOT NEW.parent_id THEN 'reparent'
                     WHEN OLD.is_placeholder != NEW.is_placeholder THEN 'group'
                     ELSE 'settings' END"""
    changes = " OR ".join(f"OLD.{f} IS NOT NEW.{f}" for f in FIELDS)
    for name, operation, kind, before in (
        ("create", "INSERT ON accounts", "'create'", "NULL"),
        ("change", f"UPDATE ON accounts WHEN {changes}", action, _snapshot("OLD")),
    ):
        conn.execute(f"""CREATE TRIGGER account_history_{name} AFTER {operation} BEGIN
            INSERT INTO account_state_events VALUES
                (NULL,{batch},NEW.id,{kind},{before},{_snapshot('NEW')},{NOW},{effective});
            END""")


def _utc(moment):
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _start(conn):
    return conn.execute("SELECT started_at FROM account_history_start").fetchone()[0]


def _effective(conn, day: date) -> str:
    start = datetime.fromisoformat(_start(conn)).astimezone(SEOUL)
    midnight = datetime.combine(day, time.min, SEOUL)
    if midnight < start or day > datetime.now(SEOUL).date():
        raise DomainValidationError("적용일은 이력 수집 시작 이후부터 오늘까지 지정하세요", code="account_history_range")
    return _utc(midnight)


# The latest correction replaces the effective time of every row in its action.
# seq is the stable tie breaker, even when a later correction creates a tie.
TIMELINE = """SELECT e.*, coalesce(c.effective_at,e.effective_at) AS applied_at,
                     coalesce(c.revision,0) AS revision
              FROM account_state_events e LEFT JOIN account_date_corrections c
              ON c.revision=(SELECT max(revision) FROM account_date_corrections WHERE batch=e.batch)"""


def _replay(conn, until=None, *, validate=False):
    where = "WHERE applied_at <= ?" if until else ""
    rows = conn.execute(f"SELECT * FROM ({TIMELINE}) {where} ORDER BY applied_at,seq", (until,) if until else ())
    states = {}
    for row in rows:
        aid = row["account_id"]
        after = json.loads(row["after_state"])
        before = json.loads(row["before_state"]) if row["before_state"] else None
        if before is None:
            states[aid] = after
        else:
            # Apply only the fields changed by this action. A later rename
            # must not overwrite an archive date corrected after the rename.
            patch = {field: value for field, value in after.items() if value != before[field]}
            if validate and (aid not in states or any(states[aid][f] != before[f] for f in patch)):
                raise DomainConflictError("같은 계정의 변경 순서와 맞지 않는 적용일입니다", code="account_history_order")
            states[aid].update(patch)
        if validate and row["action"] != "baseline":
            _validate_parent_state(states, aid)
    return states


@contextmanager
def account_action(conn, effective_date=None):
    stamp = _effective(conn, effective_date) if effective_date is not None else None
    conn.execute(f"INSERT INTO account_action_context VALUES (?,coalesce(?,{NOW}))", (uuid4().hex, stamp))
    yield
    conn.execute("DELETE FROM account_action_context")
    if stamp is not None:
        _replay(conn, validate=True)


def _validate_parent_state(states, aid):
    account = states[aid]
    parent = account["parent_id"]
    seen = {aid}
    while parent is not None:
        if parent not in states or parent in seen or (not account["archived"] and states[parent]["archived"]):
            raise DomainConflictError("상위 계정의 변경 순서와 맞지 않는 적용일입니다", code="account_history_order")
        seen.add(parent)
        parent = states[parent]["parent_id"]
    if account["archived"] and any(a["parent_id"] == aid and not a["archived"] for a in states.values()):
        raise DomainConflictError("하위 계정 보관 순서와 맞지 않는 적용일입니다", code="account_history_order")


def dated_accounts(conn: sqlite3.Connection, day: date):
    from .accounts import SqliteAccountRepository

    accounts = SqliteAccountRepository(conn).find_all()
    cutoff = _utc(datetime.combine(day, time.max, SEOUL))
    known = cutoff >= _start(conn)
    if not known or day >= datetime.now(SEOUL).date():
        return accounts, known
    states = _replay(conn, cutoff)
    result = []
    for a in accounts:
        state = states.get(a.id)
        # Keep IDs available for displaying retained postings. Accounts created
        # after this date cannot be picked and do not make their parents groups.
        patch = {"parent_id": None, "archived": True} if state is None else {
            f: state[f] if f == "parent_id" else bool(state[f])
            for f in ("archived", "is_placeholder", "parent_id", "is_overdraft")
        }
        result.append(a.model_copy(update=patch))
    return result, known


def _eligibility_intervals(account_id, started_at, events):
    """Coalesce adjacent equal states, publishing only the last seq at a boundary."""
    intervals = []
    state = {}
    children = set()
    for applied_at, changes in groupby(events, key=lambda e: e["applied_at"]):
        for event in changes:
            before, after = event["before_state"] or {}, event["after_state"]
            if event["account_id"] == account_id:
                state.update({k: v for k, v in after.items() if k not in before or before[k] != v})
            elif after["parent_id"] == account_id:
                children.add(event["account_id"])
            else:
                children.discard(event["account_id"])
        if not state:
            continue
        if state["is_system"]:
            reason = "system"
        elif state["archived"]:
            reason = "archived"
        elif state["is_placeholder"] or children:
            reason = "group"
        else:
            reason = "postable"
        if not intervals and applied_at > started_at:
            intervals.append({"start": started_at, "end": applied_at, "reason": "not_created"})
        if intervals and intervals[-1]["reason"] == reason:
            continue
        if intervals:
            intervals[-1]["end"] = applied_at
        intervals.append({"start": applied_at, "end": None, "reason": reason})
    return intervals


def account_events(conn, account_id):
    if not conn.execute("SELECT 1 FROM accounts WHERE id=?", (account_id,)).fetchone():
        raise DomainNotFoundError("계정이 없습니다", code="account_not_found")
    events = []
    for row in conn.execute(f"""SELECT * FROM ({TIMELINE}) WHERE account_id=?
        OR (json_extract(after_state,'$.parent_id') IS NOT json_extract(before_state,'$.parent_id')
            AND (? IN (json_extract(after_state,'$.parent_id'),json_extract(before_state,'$.parent_id'))))
        ORDER BY applied_at,seq""", (account_id, account_id)):
        event = dict(row)
        for key in ("before_state", "after_state"):
            event[key] = json.loads(event[key]) if event[key] else None
        events.append(event)
    batches = {e["batch"] for e in events}
    corrections = [dict(r) for r in conn.execute("SELECT * FROM account_date_corrections ORDER BY revision")
                   if r["batch"] in batches]
    started_at = _start(conn)
    return {"started_at": started_at, "events": events, "corrections": corrections,
            "intervals": _eligibility_intervals(account_id, started_at, events)}


def correct_date(conn, account_id, seq, day, expected_revision):
    with _account_write(conn):
        event = conn.execute(f"SELECT * FROM ({TIMELINE}) WHERE seq=? AND account_id=?", (seq, account_id)).fetchone()
        if event is None:
            raise DomainNotFoundError("계정 변경 기록이 없습니다", code="account_event_not_found")
        if event["action"] == "baseline":
            raise DomainValidationError("이력 수집 기준점은 정정할 수 없습니다", code="account_history_baseline")
        if event["revision"] != expected_revision:
            raise DomainConflictError("적용일이 이미 정정되었습니다. 이력을 다시 확인하세요", code="account_history_stale")
        stamp = _effective(conn, day)
        conn.execute(f"INSERT INTO account_date_corrections VALUES (NULL,?,?,?,{NOW})",
                     (event["batch"], event["applied_at"], stamp))
        _replay(conn, validate=True)
        return account_events(conn, account_id)
