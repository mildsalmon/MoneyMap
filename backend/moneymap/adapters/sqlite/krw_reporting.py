"""Whole-transaction eligibility for reports denominated in Korean won."""

# The outer transaction is aliased to t. A mismatched account disqualifies
# all legs, including otherwise eligible KRW legs in the same transaction.
KRW_TRANSACTION = """NOT EXISTS (
    SELECT 1 FROM postings leg JOIN accounts account ON account.id=leg.account_id
    WHERE leg.txn_id=t.id AND (leg.currency<>'KRW' OR account.currency<>'KRW')
)"""
