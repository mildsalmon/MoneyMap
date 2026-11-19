"""Derived actual balances, maintained atomically at the posted boundary.

Raw amounts are partitioned by currency; display signs belong to the caller.
Appending costs an indexed lookup per affected account. Backdating shifts only
later balances of those accounts, including the old accounts on an edit.
"""
from __future__ import annotations

import sqlite3


REMOVE_EFFECT = """
UPDATE account_balance_history SET balance = balance - (
  SELECT own.delta FROM account_balance_history own
  WHERE own.txn_id=OLD.id AND own.account_id=account_balance_history.account_id
    AND own.currency=account_balance_history.currency
)
WHERE (account_id,currency) IN (
  SELECT account_id,currency FROM account_balance_history WHERE txn_id=OLD.id
) AND (date,txn_id) > (OLD.date,OLD.id);
DELETE FROM account_balance_history WHERE txn_id=OLD.id;
"""

_V9_SHIFT = """
UPDATE account_balance_history SET balance = balance + (
  SELECT SUM(p.amount) FROM postings p WHERE p.txn_id=NEW.id
    AND p.account_id=account_balance_history.account_id
    AND p.currency=account_balance_history.currency
)
WHERE NEW.scenario_id=1 AND NEW.posted=1 AND (account_id,currency) IN (
  SELECT account_id,currency FROM postings WHERE txn_id=NEW.id
) AND (date,txn_id) > (NEW.date,NEW.id);
"""

# Aggregate split legs once per affected account and currency. The date index
# then locates just the later balances that must change.
_SHIFT = """
UPDATE account_balance_history SET balance = balance + change.delta
FROM (
  SELECT p.account_id,p.currency,SUM(p.amount) AS delta FROM postings p
  WHERE p.txn_id=NEW.id AND NEW.scenario_id=1 AND NEW.posted=1
  GROUP BY p.account_id,p.currency
) AS change
WHERE account_balance_history.account_id=change.account_id
  AND account_balance_history.currency=change.currency
  AND (date,txn_id) > (NEW.date,NEW.id);
"""

_INSERT = """
INSERT INTO account_balance_history(account_id,currency,txn_id,date,delta,balance)
SELECT p.account_id,p.currency,NEW.id,NEW.date,SUM(p.amount),SUM(p.amount)+COALESCE((
  SELECT b.balance FROM account_balance_history b
  WHERE b.account_id=p.account_id AND b.currency=p.currency
    AND (b.date,b.txn_id)<(NEW.date,NEW.id)
  ORDER BY b.date DESC,b.txn_id DESC LIMIT 1
),0)
FROM postings p WHERE p.txn_id=NEW.id AND NEW.scenario_id=1 AND NEW.posted=1
GROUP BY p.account_id,p.currency;
INSERT OR IGNORE INTO account_balance_keys(account_id,currency)
SELECT account_id,currency FROM postings WHERE txn_id=NEW.id AND NEW.scenario_id=1 AND NEW.posted=1;
"""


def migrate_balance_history(conn: sqlite3.Connection) -> None:
    conn.execute("""CREATE TABLE account_balance_history (
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      currency TEXT NOT NULL,
      txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      delta INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      CONSTRAINT balance_history_integer CHECK(typeof(delta)='integer' AND typeof(balance)='integer'),
      PRIMARY KEY(account_id,currency,txn_id)
    )""")
    conn.execute("CREATE INDEX idx_balance_history_order ON account_balance_history(account_id,currency,date,txn_id)")
    conn.execute("CREATE INDEX idx_balance_history_txn ON account_balance_history(txn_id)")
    # Keys may survive a deletion: a missing latest row correctly means zero.
    conn.execute("""CREATE TABLE account_balance_keys (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      currency TEXT NOT NULL, PRIMARY KEY(account_id,currency)
    )""")
    conn.execute("""INSERT INTO account_balance_history
      SELECT account_id,currency,txn_id,date,delta,
        SUM(delta) OVER (PARTITION BY account_id,currency ORDER BY date,txn_id ROWS UNBOUNDED PRECEDING)
      FROM (SELECT p.account_id,p.currency,t.id AS txn_id,t.date,SUM(p.amount) AS delta
        FROM transactions t JOIN postings p ON p.txn_id=t.id
        WHERE t.scenario_id=1 AND t.posted=1 GROUP BY p.account_id,p.currency,t.id,t.date)""")
    conn.execute("INSERT INTO account_balance_keys SELECT DISTINCT account_id,currency FROM account_balance_history")
    _create_change_trigger(conn, _V9_SHIFT)
    conn.execute(f"""CREATE TRIGGER balance_history_deleted BEFORE DELETE ON transactions
      BEGIN {REMOVE_EFFECT} END""")


def _create_change_trigger(conn: sqlite3.Connection, shift: str) -> None:
    conn.execute(f"""CREATE TRIGGER balance_history_changed
      AFTER UPDATE OF posted,date,scenario_id ON transactions
      WHEN OLD.posted!=NEW.posted OR OLD.date!=NEW.date OR OLD.scenario_id!=NEW.scenario_id
      BEGIN {REMOVE_EFFECT} {shift} {_INSERT} END""")


def migrate_balance_history_shift(conn: sqlite3.Connection) -> None:
    """Replace the v9 write trigger without rewriting existing balances."""
    conn.execute("DROP TRIGGER balance_history_changed")
    _create_change_trigger(conn, _SHIFT)


def selected_balances_after(conn: sqlite3.Connection, txn_ids: list[int], account_id: int,
                            include_descendants: bool) -> dict[int, list[dict]]:
    """One read for a page; hidden dates/tags never reset the running balance."""
    selected = ("WITH RECURSIVE selected(id) AS (SELECT ? UNION SELECT a.id FROM accounts a JOIN selected s ON a.parent_id=s.id) "
                if include_descendants else "WITH selected(id) AS (SELECT ?) ")
    marks = ','.join('?' for _ in txn_ids)
    rows = conn.execute(selected + f"""SELECT t.id,k.currency,COALESCE((
      SELECT b.balance FROM account_balance_history b
      WHERE b.account_id=k.account_id AND b.currency=k.currency
        AND (b.date,b.txn_id)<=(t.date,t.id)
      ORDER BY b.date DESC,b.txn_id DESC LIMIT 1
    ),0) AS amount
    FROM transactions t CROSS JOIN account_balance_keys k
    WHERE t.id IN ({marks}) AND k.account_id IN (SELECT id FROM selected)
    ORDER BY t.id,k.currency""", [account_id, *txn_ids])
    totals: dict[int, dict[str, int]] = {tid: {} for tid in txn_ids}
    for row in rows:
        values = totals[row['id']]
        values[row['currency']] = values.get(row['currency'], 0) + row['amount']
    # Groups may exceed SQLite int64; Python sums exactly and decimal strings
    # also prevent precision loss at the JSON -> JavaScript boundary.
    return {tid: [dict(currency=currency, amount=str(amount)) for currency, amount in values.items()]
            for tid, values in totals.items()}
