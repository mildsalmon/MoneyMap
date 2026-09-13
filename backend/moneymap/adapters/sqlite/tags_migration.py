"""Transaction tags and lossless import provenance (schema v5)."""


def migrate_tags_and_import_provenance(conn):
    conn.execute(
        "CREATE TABLE tags ("
        "id INTEGER PRIMARY KEY, "
        "name TEXT NOT NULL, "
        "name_key TEXT NOT NULL UNIQUE)"
    )
    conn.execute(
        "CREATE TABLE transaction_tags ("
        "txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, "
        "tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT, "
        "PRIMARY KEY(txn_id, tag_id))"
    )
    conn.execute(
        "CREATE INDEX idx_transaction_tags_tag ON transaction_tags(tag_id, txn_id)"
    )
    conn.execute(
        "CREATE TABLE transaction_import_provenance ("
        "txn_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE, "
        "source_hash TEXT NOT NULL, "
        "source_file TEXT NOT NULL, "
        "source_row INTEGER NOT NULL CHECK(source_row > 1), "
        "raw_date TEXT NOT NULL, "
        "raw_description TEXT NOT NULL, "
        "raw_amount TEXT NOT NULL, "
        "raw_running_total TEXT NOT NULL, "
        "raw_left_type TEXT NOT NULL, "
        "raw_left_account TEXT NOT NULL, "
        "raw_right_type TEXT NOT NULL, "
        "raw_right_account TEXT NOT NULL, "
        "raw_memo TEXT NOT NULL DEFAULT '', "
        "imported_at TEXT NOT NULL DEFAULT (datetime('now')), "
        "UNIQUE(source_hash, source_row))"
    )

