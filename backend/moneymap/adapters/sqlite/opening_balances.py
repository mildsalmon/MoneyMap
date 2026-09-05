"""The existing exact opening-balance query, shared by history and migration."""

OPENING_BALANCES_SQL = """
        WITH candidate_postings AS (
          SELECT
            t.id AS transaction_id,
            t.date AS date,
            p.account_id AS account_id,
            p.amount AS amount,
            CASE
              WHEN a.is_system=1 AND a.type='equity' AND a.name=? THEN 1
              ELSE 0
            END AS is_opening
          FROM transactions t
          JOIN postings p ON p.txn_id=t.id
          JOIN accounts a ON a.id=p.account_id
          WHERE t.scenario_id=? AND t.posted=1 AND t.source_rule_id IS NULL
        ),
        opening_matches AS (
          SELECT
            transaction_id,
            date,
            MAX(CASE WHEN is_opening=0 THEN account_id END) AS account_id,
            MAX(CASE WHEN is_opening=0 THEN amount END) AS signed_amount
          FROM candidate_postings
          GROUP BY transaction_id, date
          HAVING COUNT(*)=2
             AND SUM(amount)=0
             AND SUM(is_opening)=1
             AND SUM(CASE WHEN is_opening=0 AND amount != 0 THEN 1 ELSE 0 END)=1
        )
        SELECT transaction_id, date, account_id, signed_amount
        FROM opening_matches
        """
