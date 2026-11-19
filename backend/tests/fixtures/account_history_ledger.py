"""Synthetic ledger collected in May 2020, shared by SQLite and browser checks."""
from unittest.mock import patch

from moneymap.adapters.sqlite import connect, database, init_db


def seed_v11(path):
    conn = connect(str(path))
    with patch.object(database, "MIGRATIONS", database.MIGRATIONS[:11]):
        init_db(conn)
    with conn:
        conn.executemany("INSERT INTO accounts(id,name,type,parent_id,is_placeholder,position) VALUES(?,?,?,?,?,?)", [
            (2, "이력 통장", "asset", None, 0, 1), (3, "이력 비용", "expense", None, 0, 1),
            (4, "이전 부모", "asset", None, 0, 2), (5, "새 그룹", "asset", None, 1, 3),
            (6, "이동할 계정", "asset", 4, 0, 1),
        ])
        conn.execute("INSERT INTO transactions(id,scenario_id,date,description) VALUES(31,1,'2020-05-01','옛 거래')")
        conn.executemany("INSERT INTO postings(id,txn_id,account_id,amount) VALUES(?,31,?,?)",
                         [(41, 2, -500), (42, 3, 500)])
        conn.execute("UPDATE transactions SET posted=1 WHERE id=31")
    conn.close()


def migrate_in_may(path):
    conn = connect(str(path))
    conn.create_function("strftime", 2, lambda fmt, value: "2020-05-15T03:00:00.000Z")
    init_db(conn)
    conn.close()



if __name__ == "__main__":
    import sys
    from pathlib import Path
    import uvicorn
    from moneymap.api import create_app

    path = Path(sys.argv[1])
    seed_v11(path)
    migrate_in_may(path)
    uvicorn.run(create_app(str(path)), host="127.0.0.1", port=0)
