"""자동 백업 (D6) — 생성·하루 1회·rotation·복원 기동 테스트."""

import datetime
from pathlib import Path

from moneymap.adapters.sqlite import (
    SqliteAccountRepository,
    SqliteLedgerQueries,
    SqliteTransactionRepository,
    connect,
    init_db,
)
from moneymap.adapters.sqlite.backup import run_daily_backup
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Account,
    AccountType,
    Money,
    Posting,
    Transaction,
)

D = datetime.date
TODAY = D(2026, 7, 5)


def make_db_with_data(tmp_path: Path):
    conn = connect(str(tmp_path / "moneymap.db"))
    init_db(conn)
    acc = SqliteAccountRepository(conn)
    toss = acc.save(Account(name="Toss", type=AccountType.ASSET))
    food = acc.save(Account(name="식비", type=AccountType.EXPENSE))
    SqliteTransactionRepository(conn).save(
        Transaction(
            scenario_id=ACTUAL_SCENARIO_ID,
            date=TODAY,
            postings=[
                Posting(account_id=food.id, amount=Money(amount=52_000)),
                Posting(account_id=toss.id, amount=Money(amount=-52_000)),
            ],
        )
    )
    return conn, toss, food


def test_backup_creates_file_and_restores(tmp_path: Path):
    conn, toss, food = make_db_with_data(tmp_path)
    dest = run_daily_backup(conn, tmp_path / "backups", TODAY)
    assert dest is not None and dest.name == "moneymap-2026-07-05.db"

    # 복원 검증 (성공 기준 4): 백업 파일로 그대로 기동해 잔액이 일치해야 한다
    restored = connect(str(dest))
    init_db(restored)  # 멱등 — 복원 파일에 다시 돌려도 안전
    bal = SqliteLedgerQueries(restored).balance_at(food.id, TODAY, ACTUAL_SCENARIO_ID)
    assert bal.amount == 52_000


def test_backup_once_per_day(tmp_path: Path):
    conn, *_ = make_db_with_data(tmp_path)
    backups = tmp_path / "backups"
    assert run_daily_backup(conn, backups, TODAY) is not None
    assert run_daily_backup(conn, backups, TODAY) is None  # 같은 날 재호출은 스킵
    assert len(list(backups.glob("*.db"))) == 1
    # 다음 날은 새로 만든다
    assert run_daily_backup(conn, backups, TODAY + datetime.timedelta(days=1)) is not None
    assert len(list(backups.glob("*.db"))) == 2


def test_backup_rotation_keeps_newest(tmp_path: Path):
    conn, *_ = make_db_with_data(tmp_path)
    backups = tmp_path / "backups"
    for i in range(5):
        run_daily_backup(conn, backups, TODAY + datetime.timedelta(days=i), keep=3)
    names = sorted(p.name for p in backups.glob("*.db"))
    assert names == [
        "moneymap-2026-07-07.db",
        "moneymap-2026-07-08.db",
        "moneymap-2026-07-09.db",
    ]  # 가장 오래된 2개(7/5, 7/6)가 삭제됨
