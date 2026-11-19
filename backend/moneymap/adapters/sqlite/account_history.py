"""Account state at Seoul day close. The journal and its clock use UTC milliseconds."""
from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, time, timezone
from itertools import groupby
import json
import sqlite3
from uuid import uuid4
from zoneinfo import ZoneInfo

from moneymap.domain.services import account_name_key, validate_postable_accounts
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
        ("change", f"UPDATE ON accounts WHEN ({changes}) AND NOT EXISTS (SELECT 1 FROM account_action_context WHERE batch='projection')", action, _snapshot("OLD")),
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
                     coalesce(c.revision,0) AS revision,
                     (e.action='group' AND EXISTS (
                        SELECT 1 FROM account_state_events m WHERE m.batch=e.batch AND m.action='reparent'
                          AND json_extract(m.before_state,'$.parent_id')=e.account_id
                     )) AS automatic_group
              FROM account_state_events e LEFT JOIN account_date_corrections c
              ON c.revision=(SELECT max(revision) FROM account_date_corrections WHERE batch=e.batch)"""


def _timeline(conn, until=None):
    where = "WHERE applied_at <= ?" if until else ""
    rows = conn.execute(f"SELECT * FROM ({TIMELINE}) {where} ORDER BY applied_at,seq", (until,) if until else ())
    for row in rows:
        event = dict(row)
        event["before_state"] = json.loads(row["before_state"]) if row["before_state"] else {}
        event["after_state"] = json.loads(row["after_state"])
        yield event


class _Tree:
    """Replay account operations, including group status caused by the last child leaving."""

    def __init__(self):
        self.accounts = {}
        self.children = defaultdict(set)
        self.grouped_by_move = {}

    def apply(self, event):
        aid = event["account_id"]
        before, after = event["before_state"], event["after_state"]
        touched = {aid}
        errors = set()
        if event["automatic_group"]:
            # The recorded live-row update is audit evidence. Its effective
            # outcome was already computed at the move using the dated tree.
            return touched, errors
        patch = {k: v for k, v in after.items() if k not in before or before[k] != v}
        current = self.accounts.get(aid, {})
        if before and (not current or any(current.get(k) != before[k] for k in patch)):
            errors.add(("sequence", aid))
        previous = current.get("parent_id")
        parent = patch.get("parent_id", previous)
        if event["action"] == "reparent" and parent is not None:
            target = self.accounts.get(parent, {})
            if not target.get("is_placeholder") and not self.children[parent]:
                errors.add(("move_target_group", parent))
        if event["action"] in {"settings", "reparent"} and current.get("archived"):
            errors.add(("archived_settings", aid))
        self.accounts[aid] = {**current, **patch}
        if previous != parent:
            if previous is not None:
                self.children[previous].discard(aid)
                touched.add(previous)
            if parent is not None:
                self.children[parent].add(aid)
                touched.add(parent)
        if event["action"] == "reparent" and previous is not None:
            source = self.accounts.get(previous)
            grouped = bool(source and not self.children[previous] and not source["is_placeholder"]
                           and not source["is_system"] and not source["is_overdraft"])
            self.grouped_by_move[event["batch"]] = grouped
            if grouped:
                source["is_placeholder"] = 1
        return touched, errors

    def violations(self, touched):
        """Check changed nodes, their edges, siblings and ancestry in this snapshot."""
        errors = set()
        inspect = touched.union(*(self.children[i] for i in touched))
        for aid in inspect:
            a = self.accounts.get(aid)
            if not a or "type" not in a:
                continue
            parent_id = a["parent_id"]
            group = a["is_placeholder"] or self.children[aid]
            if a["is_overdraft"] and (group or a["is_system"] or a["type"] != "asset"):
                errors.add(("overdraft", aid))
            if a["include_in_cash"] and (group or a["is_system"] or a["archived"] or a["type"] != "asset"):
                errors.add(("cash", aid))
            if parent_id is not None:
                parent = self.accounts.get(parent_id)
                if (not parent or parent.get("type") != a["type"] or parent["is_system"]
                    or parent["is_overdraft"] or parent["include_in_cash"]
                    or (parent["archived"] and not a["archived"])):
                    errors.add(("parent", aid, parent_id))
                seen = {aid}
                cursor = parent_id
                while cursor in self.accounts:
                    if cursor in seen:
                        errors.add(("cycle", aid))
                        break
                    seen.add(cursor)
                    cursor = self.accounts[cursor].get("parent_id")
            for other_id, other in self.accounts.items():
                if (other_id != aid and other.get("parent_id") == parent_id and other.get("type") == a["type"]
                    and account_name_key(other["name"]) == account_name_key(a["name"])):
                    errors.add(("name", min(aid, other_id), max(aid, other_id)))
        return errors

    def reason(self, aid):
        state = self.accounts.get(aid)
        if not state:
            return "not_created"
        if state["is_system"]:
            return "system"
        if state["archived"]:
            return "archived"
        if state["is_placeholder"] or self.children[aid]:
            return "group"
        return "postable"


def _tree_at(conn, until):
    tree = _Tree()
    for event in _timeline(conn, until):
        tree.apply(event)
    return tree


def _validate_and_project(conn, original):
    # Walk both timelines through the union of their boundaries. Only a new
    # violation can reject a correction, including an old violation extended
    # into a new interval. Unrelated legacy defects are left as recorded.
    proposed = {(e["applied_at"], e["seq"]): e for e in _timeline(conn)}
    earlier = {(e["applied_at"], e["seq"]): e for e in original}
    old_tree, new_tree = _Tree(), _Tree()
    directly_changed = set()
    for boundary in sorted(earlier.keys() | proposed.keys()):
        old_event, new_event = earlier.get(boundary), proposed.get(boundary)
        old_ids, old_errors = old_tree.apply(old_event) if old_event else (set(), set())
        new_ids, new_errors = new_tree.apply(new_event) if new_event else (set(), set())
        touched = old_ids | new_ids
        if old_event != new_event:
            directly_changed.update(touched)
        if directly_changed:
            if new_errors - old_errors or new_tree.violations(touched) - old_tree.violations(touched):
                raise DomainConflictError("적용일이 계정 변경 순서 또는 상위 계정 조건과 맞지 않습니다",
                                          code="account_history_order")
    # A corrected move can change today's explicit-group flag even when its
    # current child count is nonzero. This is a derived write in the same lock.
    conn.execute("INSERT INTO account_action_context VALUES ('projection',NULL)")
    for row in conn.execute("SELECT id,is_placeholder FROM accounts").fetchall():
        effective = new_tree.accounts[row["id"]]["is_placeholder"]
        derived_changed = old_tree.accounts.get(row["id"], {}).get("is_placeholder") != effective
        if (derived_changed or row["id"] in directly_changed) and effective != row["is_placeholder"]:
            conn.execute("UPDATE accounts SET is_placeholder=?,version=version+1 WHERE id=?", (effective,row["id"]))
    conn.execute("DELETE FROM account_action_context")


@contextmanager
def account_action(conn, effective_date=None):
    stamp = _effective(conn, effective_date) if effective_date is not None else None
    original = list(_timeline(conn)) if stamp is not None else None
    conn.execute(f"INSERT INTO account_action_context VALUES (?,coalesce(?,{NOW}))", (uuid4().hex, stamp))
    yield
    conn.execute("DELETE FROM account_action_context")
    if original is not None:
        _validate_and_project(conn, original)


def dated_source_grouped(conn):
    context = conn.execute("SELECT * FROM account_action_context").fetchone()
    return _tree_at(conn, context["effective_at"]).grouped_by_move.get(context["batch"], False)


def dated_accounts(conn: sqlite3.Connection, day: date):
    from .accounts import SqliteAccountRepository

    accounts = SqliteAccountRepository(conn).find_all()
    # Version-pinned migration tools can still open a ledger before collection.
    if conn.execute("PRAGMA user_version").fetchone()[0] < 12:
        return accounts, False
    cutoff = _utc(datetime.combine(day, time.max, SEOUL))
    known = cutoff >= _start(conn)
    if not known or day >= datetime.now(SEOUL).date():
        return accounts, known
    states = _tree_at(conn, cutoff).accounts
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


def posting_accounts_on(conn, day, ids):
    accounts, _ = dated_accounts(conn, day)
    validate_postable_accounts(accounts, list(ids))
    selected = {a.id: a for a in accounts if a.id in ids}
    for a in selected.values():
        if a.archived or a.is_system:
            raise DomainValidationError(f"'{a.name}' 계정을 해당 거래일에 사용할 수 없습니다. 다른 계정을 선택하세요",
                                        code="account_unavailable", context={"account_id": a.id})
    return selected


def _eligibility_intervals(conn, account_id):
    tree = _Tree()
    intervals = []
    for stamp, changes in groupby(_timeline(conn), key=lambda e: e["applied_at"]):
        for event in changes:
            tree.apply(event)
        reason = tree.reason(account_id)
        if intervals and intervals[-1]["reason"] == reason:
            continue
        if intervals:
            intervals[-1]["end"] = stamp
        intervals.append({"start": stamp, "end": None, "reason": reason})
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
            "intervals": _eligibility_intervals(conn, account_id)}


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
        original = list(_timeline(conn))
        conn.execute(f"INSERT INTO account_date_corrections VALUES (NULL,?,?,?,{NOW})",
                     (event["batch"], event["applied_at"], stamp))
        _validate_and_project(conn, original)
        return account_events(conn, account_id)
