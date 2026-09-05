"""Input provenance and memo share the existing backed-up migration boundary."""
from moneymap.domain.account import OPENING_BALANCE_ACCOUNT_NAME
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID
from moneymap.domain.transaction_input import normalize_item_key

from .opening_balances import OPENING_BALANCES_SQL


def migrate_transaction_input(conn):
    conn.execute("ALTER TABLE transactions ADD COLUMN item_key TEXT NOT NULL DEFAULT ''")
    conn.execute("ALTER TABLE transactions ADD COLUMN entry_origin TEXT NOT NULL DEFAULT 'legacy_unknown' "
                 "CHECK(entry_origin IN ('user','rule','system','legacy_unknown'))")
    conn.execute("ALTER TABLE transactions ADD COLUMN memo TEXT NOT NULL DEFAULT ''")
    conn.create_function("moneymap_item_key", 1, normalize_item_key, deterministic=True)
    try:
        # Use exactly the existing opening-balance structure, not its description.
        # Rule deletion used to erase provenance; ambiguous old rows need consent.
        conn.execute(
            "UPDATE transactions SET item_key=moneymap_item_key(description), entry_origin=CASE "
            "WHEN source_rule_id IS NOT NULL THEN 'rule' "
            f"WHEN id IN (SELECT transaction_id FROM ({OPENING_BALANCES_SQL})) THEN 'system' "
            "ELSE 'legacy_unknown' END",
            (OPENING_BALANCE_ACCOUNT_NAME, ACTUAL_SCENARIO_ID),
        )
    finally:
        conn.create_function("moneymap_item_key", 1, None)
    conn.execute("CREATE INDEX idx_txn_input_item ON transactions(scenario_id,item_key,id DESC) "
                 "WHERE posted=1 AND entry_origin IN ('user','legacy_unknown')")
    conn.execute("CREATE INDEX idx_txn_input_recent ON transactions(scenario_id,id DESC) "
                 "WHERE posted=1 AND entry_origin IN ('user','legacy_unknown')")
