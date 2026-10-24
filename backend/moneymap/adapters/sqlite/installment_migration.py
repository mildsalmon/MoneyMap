"""Principal-only installment schedules, allocations, and durable retry receipts."""


def migrate_installments(conn):
    from .database import _execute_script

    _execute_script(
        conn,
        """
ALTER TABLE calculation_revisions ADD COLUMN installment_revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE installment_plans (
 id INTEGER PRIMARY KEY,
 purchase_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
 debit_account_id INTEGER NOT NULL REFERENCES accounts(id),
 card_account_id INTEGER NOT NULL REFERENCES accounts(id),
 cash_account_id INTEGER NOT NULL REFERENCES accounts(id),
 principal INTEGER NOT NULL CHECK(principal>0),
 exclude_from_spend INTEGER NOT NULL DEFAULT 0 CHECK(exclude_from_spend IN (0,1)),
 projection_mode TEXT NOT NULL DEFAULT 'pending' CHECK(projection_mode IN ('pending','separate','included')),
 rule_signature TEXT NOT NULL DEFAULT ''
);
CREATE TABLE installments (
 id INTEGER PRIMARY KEY,
 plan_id INTEGER NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
 number INTEGER NOT NULL CHECK(number>0),
 due_date TEXT NOT NULL,
 principal INTEGER NOT NULL CHECK(principal>0),
 UNIQUE(plan_id,number)
);
CREATE TABLE installment_allocations (
 transaction_id INTEGER NOT NULL REFERENCES transactions(id),
 installment_id INTEGER NOT NULL REFERENCES installments(id),
 kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),
 amount INTEGER NOT NULL CHECK(amount>0),
 PRIMARY KEY(transaction_id,installment_id)
);
CREATE INDEX idx_installment_allocations_row ON installment_allocations(installment_id);
CREATE TABLE installment_requests (
 request_id TEXT PRIMARY KEY,
 fingerprint TEXT NOT NULL,
 result TEXT NOT NULL
);
CREATE TRIGGER installment_transaction_protected BEFORE UPDATE ON transactions
WHEN EXISTS(SELECT 1 FROM installment_plans WHERE purchase_id=OLD.id)
 OR EXISTS(SELECT 1 FROM installment_allocations WHERE transaction_id=OLD.id)
BEGIN
 SELECT RAISE(ABORT,'installment_transaction_linked');
END;
CREATE TRIGGER installment_transaction_delete_protected BEFORE DELETE ON transactions
WHEN EXISTS(SELECT 1 FROM installment_plans WHERE purchase_id=OLD.id)
 OR EXISTS(SELECT 1 FROM installment_allocations WHERE transaction_id=OLD.id)
BEGIN
 SELECT RAISE(ABORT,'installment_transaction_linked');
END;
""",
    )
    # Account lifecycle must not invalidate a live installment's future postings.
    for action in ("INSERT", "UPDATE"):
        conn.execute(f"""CREATE TRIGGER installment_account_child_{action.lower()}
        BEFORE {action} ON accounts
        WHEN EXISTS(SELECT 1 FROM installment_plans p WHERE NEW.parent_id IN (p.card_account_id,p.cash_account_id))
        BEGIN SELECT RAISE(ABORT,'installment_account_linked'); END""")
    conn.execute("""CREATE TRIGGER installment_account_protected
    BEFORE UPDATE OF archived,is_placeholder,type,currency ON accounts
    WHEN EXISTS(SELECT 1 FROM installment_plans p WHERE OLD.id IN (p.card_account_id,p.cash_account_id))
      AND (NEW.archived!=OLD.archived OR NEW.is_placeholder!=OLD.is_placeholder
           OR NEW.type!=OLD.type OR NEW.currency!=OLD.currency)
    BEGIN SELECT RAISE(ABORT,'installment_account_linked'); END""")


def migrate_installment_rule_cleanup(conn):
    """Upgrade installed v7 guards without changing its ledger or allocations."""
    conn.execute("DROP TRIGGER installment_transaction_protected")
    linked = """(EXISTS(SELECT 1 FROM installment_plans WHERE purchase_id=OLD.id)
        OR EXISTS(SELECT 1 FROM installment_allocations WHERE transaction_id=OLD.id))"""
    unchanged = " AND ".join(
        f"NEW.{field} IS OLD.{field}"
        for field in (
            "id", "scenario_id", "date", "description", "posted", "item_key",
            "entry_origin", "memo", "edit_version",
        )
    )
    cleanup = f"(OLD.source_rule_id IS NOT NULL AND NEW.source_rule_id IS NULL AND {unchanged})"
    conn.execute(f"""CREATE TRIGGER installment_transaction_protected
        BEFORE UPDATE ON transactions WHEN {linked} AND NOT {cleanup}
        BEGIN SELECT RAISE(ABORT,'installment_transaction_linked'); END""")
    # Deleting a rule detaches provenance without editing the locked payment.
    # Its usual revision trigger must not attempt a second metadata UPDATE.
    conn.execute("DROP TRIGGER trg_txn_edit_update")
    fields = ("date", "description", "memo", "source_rule_id", "entry_origin", "scenario_id", "posted")
    changed = " OR ".join(f"OLD.{field} IS NOT NEW.{field}" for field in fields)
    conn.execute(f"""CREATE TRIGGER trg_txn_edit_update
        AFTER UPDATE OF {','.join(fields)} ON transactions
        WHEN ({changed}) AND NOT ({linked} AND {cleanup}) BEGIN
        UPDATE transactions SET edit_version=lower(hex(randomblob(16))) WHERE id=NEW.id;
        END""")
