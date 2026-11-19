"""Living categories are reporting metadata keyed by the original posting ID."""
from moneymap.domain.errors import DomainConflictError, DomainNotFoundError, DomainValidationError
from .common import _account_write


def migrate_living_categories(conn):
    conn.execute("""CREATE TABLE living_categories (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE
    )""")
    conn.execute("""CREATE TABLE posting_living_categories (
        posting_id INTEGER PRIMARY KEY REFERENCES postings(id) ON DELETE CASCADE,
        category_id INTEGER NOT NULL REFERENCES living_categories(id)
    )""")
    for event, ref in (("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")):
        conn.execute(f"""CREATE TRIGGER trg_living_category_edit_{event.lower()}
            AFTER {event} ON posting_living_categories BEGIN
            UPDATE transactions SET edit_version=lower(hex(randomblob(16)))
            WHERE id=(SELECT txn_id FROM postings WHERE id={ref}.posting_id);
            END""")


def catalog(conn):
    return [dict(row) for row in conn.execute("SELECT id,name FROM living_categories ORDER BY name_key")]


def save_name(conn, name, category_id=None):
    key = name.casefold()
    with _account_write(conn):
        duplicate = conn.execute("SELECT id FROM living_categories WHERE name_key=?", (key,)).fetchone()
        if duplicate and duplicate["id"] != category_id:
            raise DomainConflictError("이미 사용하는 생활 분류 이름입니다", code="category_name_taken")
        if category_id is None:
            category_id = conn.execute(
                "INSERT INTO living_categories(name,name_key) VALUES(?,?)", (name, key)
            ).lastrowid
        elif not conn.execute(
            "UPDATE living_categories SET name=?,name_key=? WHERE id=?", (name, key, category_id)
        ).rowcount:
            raise DomainNotFoundError("생활 분류가 없습니다", code="category_not_found")
    return {"id": category_id, "name": name}


def assign_category(conn, posting_id, category_id):
    if category_id is None:
        conn.execute("DELETE FROM posting_living_categories WHERE posting_id=?", (posting_id,))
        return
    if not conn.execute("""
        SELECT 1 FROM postings p JOIN accounts a ON a.id=p.account_id
        WHERE p.id=? AND a.type IN ('income','expense')
    """, (posting_id,)).fetchone():
        raise DomainValidationError("비용·수익 분개에만 생활 분류를 지정할 수 있습니다", code="category_ineligible")
    if not conn.execute("SELECT 1 FROM living_categories WHERE id=?", (category_id,)).fetchone():
        raise DomainValidationError("존재하는 생활 분류를 선택하세요", code="category_unknown")
    conn.execute("""INSERT INTO posting_living_categories(posting_id,category_id) VALUES(?,?)
        ON CONFLICT(posting_id) DO UPDATE SET category_id=excluded.category_id
        WHERE category_id<>excluded.category_id""", (posting_id, category_id))
