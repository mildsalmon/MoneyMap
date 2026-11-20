"""v16 is additive. System accounts appear only on the first confirmed exchange."""


def migrate_fx(conn):
    conn.execute("""CREATE TABLE fx_accounts (
        role TEXT NOT NULL, currency TEXT NOT NULL,
        account_id INTEGER NOT NULL UNIQUE REFERENCES accounts(id),
        PRIMARY KEY(role,currency))""")
    conn.execute("""CREATE TABLE fx_trades (
        id INTEGER PRIMARY KEY, version INTEGER NOT NULL, day TEXT NOT NULL,
        side TEXT NOT NULL, bank_id INTEGER NOT NULL REFERENCES accounts(id),
        currency TEXT NOT NULL, minor INTEGER NOT NULL CHECK(minor>0),
        cash INTEGER NOT NULL, fee INTEGER NOT NULL, principal INTEGER NOT NULL,
        rate TEXT NOT NULL, rate_date TEXT NOT NULL, source TEXT NOT NULL,
        krw_txn INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
        native_txn INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
        legacy_txn INTEGER UNIQUE REFERENCES transaction_import_provenance(txn_id),
        backup TEXT, preview_hash TEXT, editing INTEGER NOT NULL DEFAULT 0)""")
    conn.execute("CREATE INDEX fx_day_order ON fx_trades(day,id)")
    conn.execute("""CREATE TABLE fx_requests (
        request_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
        trade_id INTEGER NOT NULL REFERENCES fx_trades(id))""")
    conn.execute("""CREATE TABLE fx_quotes (
        currency TEXT NOT NULL, rate_date TEXT NOT NULL, rate TEXT NOT NULL,
        source TEXT NOT NULL, PRIMARY KEY(currency,rate_date))""")
    for operation in ("UPDATE", "DELETE"):
        conn.execute(f"""CREATE TRIGGER fx_protect_{operation.lower()} BEFORE {operation} ON transactions
            WHEN EXISTS (SELECT 1 FROM fx_trades WHERE (editing=0 AND (krw_txn=OLD.id OR native_txn=OLD.id)) OR legacy_txn=OLD.id)
            BEGIN SELECT RAISE(ABORT,'fx_trade_linked'); END""")
