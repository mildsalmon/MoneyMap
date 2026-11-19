"""Compare flow postings, grouping by transaction before attaching its tags."""
import calendar
import datetime as dt
import sqlite3

from moneymap.amounts_json import MAX_SAFE_INTEGER
from moneymap.domain.errors import DomainNotFoundError, DomainValidationError

from .krw_reporting import KRW_TRANSACTION


def previous_period(start: dt.date, end: dt.date, mode: str):
    if mode == "month":
        if start.day != 1 or start != end.replace(day=1):
            raise DomainValidationError("월 비교는 한 달의 1일부터 조회하세요")
        if start == dt.date.min:
            return None
        last = start - dt.timedelta(days=1)
        full_month = end.day == calendar.monthrange(end.year, end.month)[1]
        return last.replace(day=1), last if full_month else last.replace(day=min(end.day, last.day))
    days = (end - start).days + 1
    if start.toordinal() <= days:
        return None
    return start - dt.timedelta(days=days), start - dt.timedelta(days=1)


def _period(start, end):
    return {"start": start.isoformat(), "end": end.isoformat(), "days": (end - start).days + 1}


# Group eligible income/expense legs using their explicit assignments. NULL remains
# the unclassified bucket. A refund therefore has the same sign in every view.
_FLOWS = f"""
WITH flows AS (
  SELECT t.id, t.date, t.description, t.date>=:start AS current,
         SUM(CASE WHEN a.type='income' THEN -p.amount ELSE 0 END) AS income,
         SUM(CASE WHEN a.type='expense' THEN p.amount ELSE 0 END) AS expense
  FROM transactions t JOIN postings p ON p.txn_id=t.id JOIN accounts a ON a.id=p.account_id
  LEFT JOIN posting_living_categories pc ON pc.posting_id=p.id
  WHERE t.scenario_id=1 AND t.posted=1 AND {KRW_TRANSACTION}
    AND ((t.date BETWEEN :start AND :end) OR (t.date BETWEEN :prev_start AND :prev_end))
    AND a.type IN ('income','expense')
    AND (:category IS NULL OR pc.category_id=:category OR (:category='unclassified' AND pc.category_id IS NULL))
  GROUP BY t.id
)
"""


def _amounts(row):
    values = {key: row[key] for key in ("income", "expense")}
    if any(abs(v) > MAX_SAFE_INTEGER for v in values.values()):
        raise DomainValidationError("통계 비교 금액이 정확히 표시할 수 있는 정수 범위를 넘었습니다",
                                    code="statistics_amount_out_of_range")
    return values


def read_comparison(conn: sqlite3.Connection, start: dt.date, end: dt.date, mode: str,
                    category: str | None, tag_id: int | None, detail: str | None, page: int):
    previous = previous_period(start, end, mode)
    params = {"start": start.isoformat(), "end": end.isoformat(), "category": category,
              "prev_start": previous[0].isoformat() if previous else None,
              "prev_end": previous[1].isoformat() if previous else None}
    categories = [dict(row) for row in conn.execute("SELECT id,name FROM living_categories ORDER BY name_key")]
    if category not in (None, "unclassified") and not any(str(c["id"]) == category for c in categories):
        raise DomainValidationError("생활 분류를 찾을 수 없습니다")
    empty = {"income": 0, "expense": 0}
    def totals():
        return {"current": empty.copy(), "previous": empty.copy()}

    overall = totals()
    tags = {}
    for row in conn.execute(_FLOWS + """
        , buckets AS (
          SELECT NULL AS tag_id, current, income, expense FROM flows
          UNION ALL
          SELECT tt.tag_id, f.current, f.income, f.expense
          FROM flows f JOIN transaction_tags tt ON tt.txn_id=f.id
        )
        SELECT b.tag_id, g.name, current, SUM(income) AS income, SUM(expense) AS expense
        FROM buckets b LEFT JOIN tags g ON g.id=b.tag_id
        GROUP BY b.tag_id,current ORDER BY g.name_key, b.tag_id
    """, params):
        bucket = overall if row["tag_id"] is None else tags.setdefault(row["tag_id"], {
            "tag_id": row["tag_id"], "name": row["name"], **totals()})
        bucket["current" if row["current"] else "previous"] = _amounts(row)

    # A bookmarked tag can lose its last matching posting after a ledger edit.
    if tag_id is not None and tag_id not in tags:
        tag = conn.execute("SELECT name FROM tags WHERE id=?", (tag_id,)).fetchone()
        if tag is None:
            raise DomainNotFoundError("태그를 찾을 수 없습니다")
        tags[tag_id] = {"tag_id": tag_id, "name": tag["name"], **totals()}

    result = {"current": _period(start, end), "previous": _period(*previous) if previous else None,
              "overall": overall, "tags": list(tags.values()), "categories": categories}
    if detail:
        params.update(current=int(detail == "current"), tag=tag_id, offset=(page - 1) * 50)
        rows = conn.execute(_FLOWS + """
          SELECT id,date,description,income,expense FROM flows f
          WHERE current=:current AND (:tag IS NULL OR EXISTS (
            SELECT 1 FROM transaction_tags tt WHERE tt.txn_id=f.id AND tt.tag_id=:tag))
          ORDER BY date DESC,id DESC LIMIT 51 OFFSET :offset
        """, params).fetchall()
        result["details"] = {"has_more": len(rows) > 50, "items": [
            {"id": r["id"], "date": r["date"], "description": r["description"], **_amounts(r)}
            for r in rows[:50]]}
    return result
