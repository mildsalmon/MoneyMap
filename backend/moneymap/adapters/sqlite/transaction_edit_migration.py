"""Edit revisions cover every SQL writer, not only the HTTP edit endpoint.

Revisions are opaque, so several row changes within one atomic write are safe.
The insert trigger also covers legacy imports and numeric transaction ID reuse.
Request receipts intentionally outlive transaction deletion: no user field copies.
"""


def migrate_transaction_edit(conn):
    conn.execute("ALTER TABLE transactions ADD COLUMN edit_version TEXT NOT NULL DEFAULT ''")
    conn.execute("UPDATE transactions SET edit_version=lower(hex(randomblob(16)))")
    conn.execute("""CREATE TRIGGER trg_txn_edit_insert AFTER INSERT ON transactions BEGIN
        UPDATE transactions SET edit_version=lower(hex(randomblob(16))) WHERE id=NEW.id;
        END""")
    fields = ("date", "description", "memo", "source_rule_id", "entry_origin", "scenario_id", "posted")
    changed = " OR ".join(f"OLD.{field} IS NOT NEW.{field}" for field in fields)
    conn.execute(f"""CREATE TRIGGER trg_txn_edit_update
        AFTER UPDATE OF {','.join(fields)} ON transactions WHEN {changed} BEGIN
        UPDATE transactions SET edit_version=lower(hex(randomblob(16))) WHERE id=NEW.id;
        END""")
    # Source table/field names below are constants, never request input.
    for table, fields in (("postings", ("txn_id", "account_id", "amount", "currency")),
                          ("transaction_tags", ("txn_id", "tag_id"))):
        for event in ("INSERT", "UPDATE", "DELETE"):
            refs = "OLD.txn_id,NEW.txn_id" if event == "UPDATE" else f"{'OLD' if event == 'DELETE' else 'NEW'}.txn_id"
            when = " WHEN " + " OR ".join(f"OLD.{f} IS NOT NEW.{f}" for f in fields) if event == "UPDATE" else ""
            conn.execute(f"""CREATE TRIGGER trg_{table}_edit_{event.lower()}
                AFTER {event} ON {table}{when} BEGIN
                UPDATE transactions SET edit_version=lower(hex(randomblob(16))) WHERE id IN ({refs});
                END""")
    conn.execute("""CREATE TABLE transaction_edit_requests (
        request_id TEXT PRIMARY KEY,
        txn_id INTEGER NOT NULL,
        expected_version TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('applied','not_applied')),
        result_version TEXT,
        CHECK ((outcome='applied' AND result_version IS NOT NULL)
            OR (outcome='not_applied' AND result_version IS NULL))
    )""")
