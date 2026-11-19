"""Read-only KRW overview; every aggregate uses the same whole-transaction cohort."""
from __future__ import annotations

import calendar
import datetime as dt
import sqlite3

from .statistics_comparison import read_comparison
from .accounts import SqliteAccountRepository
from .krw_reporting import KRW_TRANSACTION
from moneymap.domain.account import reporting_type
from moneymap.domain.errors import DomainValidationError

# Excluding individual postings would break double-entry identities. Legacy data
# can reference an account whose currency does not match the posting currency.
_COHORT = f"""
WITH cohort AS (
 SELECT t.id,t.date,{KRW_TRANSACTION} AS eligible
 FROM transactions t WHERE t.scenario_id=1 AND t.posted=1 AND t.date<=:end
)
"""


def read_statistics(conn: sqlite3.Connection, start: dt.date, end: dt.date, *,
                    comparison: str | None = None, category_id: str | None = None,
                    tag_id: int | None = None, detail: str | None = None, page: int = 1) -> dict:
    try:
        result = _read_statistics(conn, start, end)
        if comparison:
            result["comparison"] = read_comparison(conn, start, end, comparison, category_id, tag_id, detail, page)
        return result
    except sqlite3.OperationalError as exc:
        if str(exc) != "integer overflow":
            raise
        # SQLite can overflow during SUM even when later reversals cancel it.
        raise DomainValidationError(
            "통계 집계가 정확히 계산할 수 있는 정수 범위를 넘었습니다",
            code="statistics_amount_out_of_range",
        ) from exc


def _read_statistics(conn: sqlite3.Connection, start: dt.date, end: dt.date) -> dict:
    if not conn.in_transaction:
        raise RuntimeError("Statistics requires a read snapshot")
    params = {"start": start.isoformat(), "end": end.isoformat()}
    accounts = SqliteAccountRepository(conn).find_all()
    own = {row["account_id"]: row for row in conn.execute(_COHORT + """
      SELECT p.account_id,
        COALESCE(SUM(CASE WHEN t.date<:start THEN p.amount ELSE 0 END),0) AS opening,
        COALESCE(SUM(CASE WHEN t.date>=:start THEN p.amount ELSE 0 END),0) AS period,
        SUM(p.amount) AS closing,
        SUM(CASE WHEN t.date>=:start THEN 1 ELSE 0 END) AS activity
      FROM cohort t JOIN postings p ON p.txn_id=t.id
      WHERE t.eligible GROUP BY p.account_id
    """, params)}
    changes = {row["month"]: row for row in conn.execute(_COHORT + """
      SELECT substr(t.date,1,7) AS month,
        SUM(CASE WHEN a.type='income' THEN -p.amount ELSE 0 END) AS income,
        SUM(CASE WHEN a.type='expense' THEN p.amount ELSE 0 END) AS expense,
        SUM(CASE WHEN a.type='equity' THEN -p.amount ELSE 0 END) AS capital_change,
        SUM(CASE WHEN a.type IN ('asset','liability') THEN p.amount ELSE 0 END) AS net_worth_change
      FROM cohort t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id
      WHERE t.eligible AND t.date>=:start GROUP BY substr(t.date,1,7)
    """, params)}
    # Share the cohort evaluation with the transaction counts. The counts CTE
    # always yields one row, including for periods with no eligible postings.
    category_rows = conn.execute(_COHORT + """
      , counts AS (
        SELECT COUNT(*) FILTER (WHERE eligible AND date>=:start) AS included,
               COUNT(*) FILTER (WHERE NOT eligible) AS excluded FROM cohort
      ), category_totals AS (
        SELECT c.id AS category_id, c.name, c.name_key,
          SUM(CASE WHEN a.type='income' THEN -p.amount ELSE 0 END) AS income,
          SUM(CASE WHEN a.type='expense' THEN p.amount ELSE 0 END) AS expense
        FROM cohort t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id
        LEFT JOIN posting_living_categories pc ON pc.posting_id=p.id
        LEFT JOIN living_categories c ON c.id=pc.category_id
        WHERE t.eligible AND t.date>=:start AND a.type IN ('income','expense')
        GROUP BY c.id
      )
      SELECT counts.*, category_id, COALESCE(name,'미분류') AS name,
             COALESCE(income,0) AS income, COALESCE(expense,0) AS expense
      FROM counts LEFT JOIN category_totals ON TRUE ORDER BY category_id IS NULL, name_key
    """, params).fetchall()
    counts = category_rows[0]
    categories = [{key: row[key] for key in ("category_id", "name", "income", "expense")}
                  for row in category_rows]
    if categories[-1]["category_id"] is not None:
        categories.append({"category_id": None, "name": "미분류", "income": 0, "expense": 0})

    opening_nw = closing_nw = assets = liabilities = income = expense = capital = 0
    rows = []
    for account in accounts:
        value = own.get(account.id)
        opening, closing, period, activity = (
            (value["opening"], value["closing"], value["period"], value["activity"])
            if value else (0, 0, 0, 0)
        )
        kind = account.type.value
        reported = reporting_type(account, closing).value
        if kind in {"asset", "liability"}:
            opening_nw += opening
            closing_nw += closing
            if reported == "asset":
                assets += closing
            else:
                liabilities -= closing
        elif kind == "income":
            income -= period
        elif kind == "expense":
            expense += period
        else:
            capital -= period
        rows.append({"account_id": account.id, "opening": opening, "balance": closing,
                     "period": period, "activity": activity, "reporting_type": reported})

    monthly = []
    year, month = start.year, start.month
    running = opening_nw
    while (year, month) <= (end.year, end.month):
        key = f"{year:04d}-{month:02d}"
        change = changes.get(key)
        earned, spent, contribution, delta = (
            (change["income"], change["expense"], change["capital_change"], change["net_worth_change"])
            if change else (0, 0, 0, 0)
        )
        running += delta
        month_end = min(end, dt.date(year, month, calendar.monthrange(year, month)[1]))
        monthly.append({"month": key, "through": month_end.isoformat(), "income": earned,
                        "expense": spent, "net_income": earned - spent,
                        "capital_change": contribution, "net_worth": running})
        if month == 12:
            year, month = year + 1, 1
        else:
            month += 1

    result = {**params, "currency": "KRW", "transaction_count": counts["included"],
            "excluded_transaction_count": counts["excluded"],
            "summary": {"income": income, "expense": expense, "net_income": income - expense,
                        "opening_net_worth": opening_nw, "net_worth": closing_nw,
                        "net_worth_change": closing_nw - opening_nw,
                        "assets": assets, "liabilities": liabilities, "capital_change": capital,
                        "reconciliation_difference": closing_nw - opening_nw - (income - expense + capital)},
            "categories": categories, "monthly": monthly, "accounts": [a.model_dump(mode="json") for a in accounts], "balances": rows}

    # JSON numbers become JavaScript doubles; refuse aggregates that would lose
    # a won even when each individual transaction was a valid safe integer.
    amounts = [*result["summary"].values()]
    amounts.extend(row[key] for row in categories for key in ("income", "expense"))
    amounts.extend(value for row in rows for key, value in row.items() if key in {"opening", "balance", "period"})
    amounts.extend(value for row in monthly for key, value in row.items() if key not in {"month", "through"})
    if any(abs(value) > 9_007_199_254_740_991 for value in amounts):
        raise DomainValidationError("통계 합계가 정확히 표시할 수 있는 정수 범위를 넘었습니다", code="statistics_amount_out_of_range")
    return result
