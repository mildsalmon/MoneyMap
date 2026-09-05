"""SQLite 어댑터 통합 테스트 — 실제 SQLite(인메모리)로 검증."""

import datetime
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from moneymap.adapters.sqlite import (
    SqliteAccountRepository,
    SqliteLedgerQueries,
    SqliteRecurringRuleRepository,
    SqliteScenarioRepository,
    SqliteTransactionRepository,
    connect,
    init_db,
)
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Account,
    AccountSettingsCommand,
    AccountType,
    DomainConflictError,
    DomainInvariantError,
    DomainUnavailableError,
    Money,
    Posting,
    RecurringRule,
    Scenario,
    Schedule,
    Transaction,
)
from moneymap.domain.account import OPENING_BALANCE_ACCOUNT_NAME

D = datetime.date


@pytest.fixture
def conn() -> sqlite3.Connection:
    c = connect(":memory:")
    init_db(c)
    return c


@pytest.fixture
def accounts(conn) -> dict[str, Account]:
    repo = SqliteAccountRepository(conn)
    return {
        "toss": repo.create(Account(name="Toss", type=AccountType.ASSET)),
        "food": repo.create(Account(name="식비", type=AccountType.EXPENSE)),
        "card": repo.create(Account(name="현대카드", type=AccountType.LIABILITY)),
        "opening": repo.find_by_name(OPENING_BALANCE_ACCOUNT_NAME),
    }


def expense_txn(
    scenario_id: int, date: D, food_id: int, card_id: int, amount: int
) -> Transaction:
    return Transaction(
        scenario_id=scenario_id,
        date=date,
        description="지출",
        postings=[
            Posting(account_id=food_id, amount=Money(amount=amount)),
            Posting(account_id=card_id, amount=Money(amount=-amount)),
        ],
    )


def settings_command(account: Account, **changes) -> AccountSettingsCommand:
    assert account.id is not None
    values = {
        "account_id": account.id,
        "name": account.name,
        "parent_id": account.parent_id,
        "is_overdraft": account.is_overdraft,
        "version": account.version,
        **changes,
    }
    return AccountSettingsCommand(**values)


# ─── 시드 ───────────────────────────────────────────────


def test_seeds(conn):
    sc = SqliteScenarioRepository(conn).find_by_id(ACTUAL_SCENARIO_ID)
    assert sc is not None and sc.is_actual and sc.name == "actual"

    opening = SqliteAccountRepository(conn).find_by_name(OPENING_BALANCE_ACCOUNT_NAME)
    assert opening is not None and opening.type == AccountType.EQUITY


def test_init_db_idempotent(conn):
    init_db(conn)  # 두 번 불러도 시드 중복 없음
    rows = conn.execute(
        "SELECT COUNT(*) AS n FROM accounts WHERE name=?",
        (OPENING_BALANCE_ACCOUNT_NAME,),
    ).fetchone()
    assert rows["n"] == 1


def test_position_version_migration_is_deterministic_and_idempotent():
    legacy = connect(":memory:")
    legacy.execute("""
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          parent_id INTEGER,
          currency TEXT NOT NULL DEFAULT 'KRW',
          archived INTEGER NOT NULL DEFAULT 0,
          is_placeholder INTEGER NOT NULL DEFAULT 0,
          is_system INTEGER NOT NULL DEFAULT 0,
          is_overdraft INTEGER NOT NULL DEFAULT 0
        )
    """)
    first_root = legacy.execute(
        "INSERT INTO accounts (name, type) VALUES ('먼저 만든 루트', 'asset')"
    ).lastrowid
    second_root = legacy.execute(
        "INSERT INTO accounts (name, type, archived) VALUES ('나중 루트', 'asset', 1)"
    ).lastrowid
    first_child = legacy.execute(
        "INSERT INTO accounts (name, type, parent_id) VALUES ('첫 자식', 'asset', ?)",
        (first_root,),
    ).lastrowid
    second_child = legacy.execute(
        "INSERT INTO accounts (name, type, parent_id) VALUES ('둘째 자식', 'asset', ?)",
        (first_root,),
    ).lastrowid
    other_parent_child = legacy.execute(
        "INSERT INTO accounts (name, type, parent_id) VALUES ('다른 범위', 'asset', ?)",
        (second_root,),
    ).lastrowid

    legacy.commit()
    init_db(legacy)

    rows = {
        row["id"]: (row["position"], row["version"])
        for row in legacy.execute(
            "SELECT id, position, version FROM accounts WHERE type='asset'"
        )
    }
    assert rows[first_root] == (1, 1)
    assert rows[second_root] == (2, 1)
    assert rows[first_child] == (1, 1)
    assert rows[second_child] == (2, 1)
    assert rows[other_parent_child] == (1, 1)

    legacy.execute(
        "UPDATE accounts SET position=9 WHERE id=?",
        (second_child,),
    )
    legacy.commit()
    legacy.commit()
    init_db(legacy)
    assert (
        legacy.execute(
            "SELECT position FROM accounts WHERE id=?",
            (second_child,),
        ).fetchone()["position"]
        == 9
    )


def test_position_migration_rolls_back_schema_changes_on_failure():
    legacy = connect(":memory:")
    legacy.execute("""
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          parent_id INTEGER,
          currency TEXT NOT NULL DEFAULT 'KRW'
        )
    """)
    legacy.execute("CREATE TABLE idx_accounts_sibling_position (id INTEGER)")
    legacy.execute("INSERT INTO accounts (name, type) VALUES ('현금', 'asset')")
    legacy.commit()

    with pytest.raises(sqlite3.OperationalError, match="already a table"):
        init_db(legacy)

    columns = {row["name"] for row in legacy.execute("PRAGMA table_info(accounts)")}
    assert "position" not in columns
    assert "version" not in columns


def test_account_positions_allocate_per_sibling_scope_and_updates_preserve_order(conn):
    repo = SqliteAccountRepository(conn)
    first = repo.create(Account(name="첫 루트", type=AccountType.ASSET))
    second = repo.create(Account(name="둘째 루트", type=AccountType.ASSET))
    child = repo.create(
        Account(name="첫 자식", type=AccountType.ASSET, parent_id=first.id)
    )

    assert (first.position, second.position, child.position) == (1, 2, 1)
    renamed = repo.update_settings(settings_command(second, name="이름 변경")).account
    archived = repo.set_archived(renamed.id, True)
    assert archived.position == 2
    assert archived.version == 3

    query_plan = " ".join(
        row["detail"]
        for row in conn.execute(
            "EXPLAIN QUERY PLAN "
            "SELECT COALESCE(MAX(position), 0) + 1 FROM accounts "
            "INDEXED BY idx_accounts_sibling_position "
            "WHERE type=? AND COALESCE(parent_id, -1)=COALESCE(?, -1)",
            ("asset", None),
        )
    )
    assert "idx_accounts_sibling_position" in query_plan


def test_position_constraints_block_raw_invalid_or_duplicate_values(conn):
    repo = SqliteAccountRepository(conn)
    account = repo.create(Account(name="현금", type=AccountType.ASSET))

    with pytest.raises(sqlite3.IntegrityError, match="account_position_invalid"):
        conn.execute(
            "INSERT INTO accounts (name, type, position) VALUES ('잘못된 위치', 'asset', 0)"
        )
    conn.rollback()

    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE constraint failed"):
        conn.execute(
            "INSERT INTO accounts (name, type, position) VALUES ('중복 위치', 'asset', ?)",
            (account.position,),
        )
    conn.rollback()


def test_system_account_version_changes_only_when_bootstrap_repairs_it(conn):
    repo = SqliteAccountRepository(conn)
    opening = repo.find_by_name(OPENING_BALANCE_ACCOUNT_NAME)
    assert opening.version == 1

    init_db(conn)
    assert repo.find_by_id(opening.id).version == 1


# ─── 계정 ───────────────────────────────────────────────


def test_account_roundtrip(conn, accounts):
    repo = SqliteAccountRepository(conn)
    found = repo.find_by_id(accounts["toss"].id)
    assert found == accounts["toss"]
    assert len(repo.find_all()) == 4  # 시드 1 + 생성 3


def test_account_overdraft_roundtrip_and_reversible(conn):
    repo = SqliteAccountRepository(conn)
    account = repo.create(
        Account(name="카오뱅크", type=AccountType.ASSET, is_overdraft=True)
    )
    assert repo.find_by_id(account.id).is_overdraft is True
    disabled = repo.update_settings(
        settings_command(account, is_overdraft=False)
    ).account
    assert disabled.is_overdraft is False
    enabled = repo.update_settings(
        settings_command(disabled, is_overdraft=True)
    ).account
    assert enabled.is_overdraft is True


def test_overdraft_migration_defaults_existing_rows_and_is_idempotent():
    legacy = connect(":memory:")
    legacy.execute("""
        CREATE TABLE accounts (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          parent_id INTEGER,
          currency TEXT NOT NULL DEFAULT 'KRW',
          archived INTEGER NOT NULL DEFAULT 0,
          is_placeholder INTEGER NOT NULL DEFAULT 0,
          is_system INTEGER NOT NULL DEFAULT 0
        )
    """)
    account_id = legacy.execute(
        "INSERT INTO accounts (name, type) VALUES ('현금', 'asset')"
    ).lastrowid

    legacy.commit()
    init_db(legacy)
    legacy.commit()
    init_db(legacy)

    row = legacy.execute(
        "SELECT is_overdraft FROM accounts WHERE id=?",
        (account_id,),
    ).fetchone()
    assert row["is_overdraft"] == 0


def test_overdraft_triggers_block_invalid_shape_and_children(conn):
    repo = SqliteAccountRepository(conn)
    with pytest.raises(DomainConflictError) as shape_error:
        repo.create(
            Account(
                name="잘못된 대출",
                type=AccountType.LIABILITY,
                is_overdraft=True,
            )
        )
    assert shape_error.value.code == "overdraft_invalid_account"

    overdraft = repo.create(
        Account(name="우리은행", type=AccountType.ASSET, is_overdraft=True)
    )
    with pytest.raises(DomainConflictError) as child_error:
        repo.create(
            Account(
                name="하위 계정",
                type=AccountType.ASSET,
                parent_id=overdraft.id,
            )
        )
    assert child_error.value.code == "overdraft_parent_forbids_children"

    with pytest.raises(sqlite3.IntegrityError, match="overdraft_cannot_be_group"):
        conn.execute(
            "UPDATE accounts SET is_placeholder=1 WHERE id=?",
            (overdraft.id,),
        )
    conn.rollback()

    parent = repo.create(Account(name="자식 있는 계정", type=AccountType.ASSET))
    repo.create(Account(name="기존 자식", type=AccountType.ASSET, parent_id=parent.id))
    with pytest.raises(sqlite3.IntegrityError, match="overdraft_requires_leaf"):
        conn.execute(
            "UPDATE accounts SET is_overdraft=1 WHERE id=?",
            (parent.id,),
        )
    conn.rollback()

    movable = repo.create(Account(name="이동할 계정", type=AccountType.ASSET))
    with pytest.raises(
        sqlite3.IntegrityError, match="overdraft_parent_forbids_children"
    ):
        conn.execute(
            "UPDATE accounts SET parent_id=? WHERE id=?",
            (overdraft.id, movable.id),
        )
    conn.rollback()


def test_overdraft_transition_rejects_existing_children_and_archived(conn):
    repo = SqliteAccountRepository(conn)
    parent = repo.create(Account(name="입출금", type=AccountType.ASSET))
    repo.create(Account(name="국민은행", type=AccountType.ASSET, parent_id=parent.id))
    with pytest.raises(DomainConflictError) as child_error:
        repo.update_settings(settings_command(parent, is_overdraft=True))
    assert child_error.value.code == "overdraft_requires_leaf"

    archived = repo.create(
        Account(name="보관 통장", type=AccountType.ASSET, archived=True)
    )
    with pytest.raises(DomainConflictError) as archived_error:
        repo.update_settings(settings_command(archived, is_overdraft=True))
    assert archived_error.value.code == "archived_account_read_only"


def test_atomic_settings_move_allocates_last_position_and_groups_empty_source(conn):
    repo = SqliteAccountRepository(conn)
    source = repo.create(Account(name="저축", type=AccountType.ASSET))
    target = repo.create(
        Account(name="입출금", type=AccountType.ASSET, is_placeholder=True)
    )
    existing = repo.create(
        Account(name="기존 통장", type=AccountType.ASSET, parent_id=target.id)
    )
    moving = repo.create(
        Account(name="기업은행", type=AccountType.ASSET, parent_id=source.id)
    )

    result = repo.update_settings(
        settings_command(
            moving,
            name=" 기업은행 급여통장 ",
            parent_id=target.id,
            is_overdraft=True,
        )
    )

    assert result.account.name == "기업은행 급여통장"
    assert result.account.parent_id == target.id
    assert result.account.is_overdraft is True
    assert result.account.position == existing.position + 1
    assert result.account.version == moving.version + 1
    assert result.effects.model_dump() == {
        "moved": True,
        "previous_parent_id": source.id,
        "source_parent_grouped": True,
    }
    repaired_source = repo.find_by_id(source.id)
    assert repaired_source.is_placeholder is True
    assert repaired_source.version == source.version + 1


def test_concurrent_settings_move_and_create_serialize_sibling_positions(tmp_path):
    db_path = tmp_path / "concurrent-account-writes.db"
    setup_conn = connect(str(db_path))
    init_db(setup_conn)
    setup_repo = SqliteAccountRepository(setup_conn)
    source = setup_repo.create(Account(name="원본 그룹", type=AccountType.ASSET))
    target = setup_repo.create(
        Account(name="대상 그룹", type=AccountType.ASSET, is_placeholder=True)
    )
    existing = setup_repo.create(
        Account(name="기존 계정", type=AccountType.ASSET, parent_id=target.id)
    )
    moving = setup_repo.create(
        Account(name="이동 계정", type=AccountType.ASSET, parent_id=source.id)
    )
    start = Barrier(2)

    def move_account() -> Account:
        worker_conn = connect(str(db_path))
        try:
            start.wait()
            return (
                SqliteAccountRepository(worker_conn)
                .update_settings(settings_command(moving, parent_id=target.id))
                .account
            )
        finally:
            worker_conn.close()

    def create_account() -> Account:
        worker_conn = connect(str(db_path))
        try:
            start.wait()
            return SqliteAccountRepository(worker_conn).create(
                Account(
                    name="동시 생성 계정",
                    type=AccountType.ASSET,
                    parent_id=target.id,
                )
            )
        finally:
            worker_conn.close()

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            moved_future = executor.submit(move_account)
            created_future = executor.submit(create_account)
            moved = moved_future.result(timeout=5)
            created = created_future.result(timeout=5)

        children = [
            account
            for account in setup_repo.find_all()
            if account.parent_id == target.id
        ]
        assert {account.id for account in children} == {
            existing.id,
            moving.id,
            created.id,
        }
        assert sorted(account.position for account in children) == [1, 2, 3]
        assert moved.version == moving.version + 1
    finally:
        setup_conn.close()


def test_atomic_settings_stale_version_writes_nothing(conn):
    repo = SqliteAccountRepository(conn)
    first_parent = repo.create(
        Account(name="첫 그룹", type=AccountType.ASSET, is_placeholder=True)
    )
    second_parent = repo.create(
        Account(name="둘째 그룹", type=AccountType.ASSET, is_placeholder=True)
    )
    account = repo.create(
        Account(name="통장", type=AccountType.ASSET, parent_id=first_parent.id)
    )
    renamed = repo.update_settings(settings_command(account, name="최신 이름")).account

    with pytest.raises(DomainConflictError) as error:
        repo.update_settings(
            settings_command(
                account,
                name="오래된 이름",
                parent_id=second_parent.id,
                is_overdraft=True,
            )
        )
    assert error.value.code == "account_settings_stale"
    assert repo.find_by_id(account.id) == renamed
    assert repo.find_by_id(first_parent.id).is_placeholder is True


def test_atomic_settings_rolls_back_every_field_and_source_cleanup(conn):
    repo = SqliteAccountRepository(conn)
    source = repo.create(Account(name="원본", type=AccountType.ASSET))
    target = repo.create(
        Account(name="대상", type=AccountType.ASSET, is_placeholder=True)
    )
    moving = repo.create(
        Account(name="이동", type=AccountType.ASSET, parent_id=source.id)
    )
    conn.execute(f"""
        CREATE TRIGGER fail_account_settings
        BEFORE UPDATE OF name ON accounts
        WHEN NEW.id = {moving.id}
        BEGIN SELECT RAISE(ABORT, 'account_position_invalid'); END;
    """)
    conn.commit()

    with pytest.raises(DomainInvariantError):
        repo.update_settings(
            settings_command(
                moving,
                name="실패 이름",
                parent_id=target.id,
                is_overdraft=True,
            )
        )

    assert repo.find_by_id(moving.id) == moving
    assert repo.find_by_id(source.id) == source


def test_explicit_account_state_writers_increment_version(conn):
    repo = SqliteAccountRepository(conn)
    account = repo.create(Account(name="현금", type=AccountType.ASSET))
    grouped = repo.set_placeholder(account.id, True)
    archived = repo.set_archived(account.id, True)
    restored = repo.set_archived(account.id, False)
    assert grouped.version == 2
    assert archived.version == 3
    assert restored.version == 4


def test_account_write_translates_database_busy(tmp_path):
    db_path = tmp_path / "locked.db"
    owner = connect(str(db_path))
    init_db(owner)
    contender = connect(str(db_path))
    contender.execute("PRAGMA busy_timeout = 1")
    owner.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(DomainUnavailableError) as error:
            SqliteAccountRepository(contender).create(
                Account(name="대기", type=AccountType.ASSET)
            )
        assert error.value.code == "database_busy"
        assert error.value.context == {"retryable": True}
    finally:
        owner.rollback()
        contender.close()
        owner.close()


def test_opening_balance_create_match_duplicate_delete_and_recreate(conn):
    account_repo = SqliteAccountRepository(conn)
    txn_repo = SqliteTransactionRepository(conn)
    overdraft = account_repo.create(
        Account(name="케이뱅크", type=AccountType.ASSET, is_overdraft=True)
    )

    created = txn_repo.create_opening_balance(
        overdraft.id,
        D(2026, 8, 2),
        74_566_154,
        "negative",
    )
    assert [p.amount.amount for p in created.postings] == [-74_566_154, 74_566_154]
    assert txn_repo.find_opening_balances(overdraft.id) == [
        {
            "account_id": overdraft.id,
            "transaction_id": created.id,
            "date": "2026-08-02",
            "state": "negative",
        }
    ]

    with pytest.raises(DomainConflictError) as duplicate_error:
        txn_repo.create_opening_balance(
            overdraft.id,
            D(2026, 8, 3),
            1,
            "positive",
        )
    assert duplicate_error.value.code == "opening_already_recorded"

    assert txn_repo.delete(created.id) is True
    replacement = txn_repo.create_opening_balance(
        overdraft.id,
        D(2026, 8, 3),
        1,
        "positive",
    )
    assert replacement.id is not None


def test_opening_matcher_uses_structure_not_description(conn):
    from moneymap.adapters.sqlite.transactions import _insert_txn

    account_repo = SqliteAccountRepository(conn)
    txn_repo = SqliteTransactionRepository(conn)
    cash = account_repo.create(Account(name="현금", type=AccountType.ASSET))
    opening = account_repo.find_by_name(OPENING_BALANCE_ACCOUNT_NAME)
    historical = Transaction(
        scenario_id=ACTUAL_SCENARIO_ID,
        date=D(2026, 8, 2),
        description="자유 문구",
        postings=[
            Posting(account_id=cash.id, amount=Money(amount=1000)),
            Posting(account_id=opening.id, amount=Money(amount=-1000)),
        ],
    )
    with conn:
        transaction_id = _insert_txn(conn, historical)
    assert txn_repo.find_opening_balances(cash.id)[0]["transaction_id"] == transaction_id


def test_opening_matcher_excludes_three_leg_transaction(conn):
    account_repo = SqliteAccountRepository(conn)
    txn_repo = SqliteTransactionRepository(conn)
    # Historical shapes remain readable even though ordinary input now rejects
    # system-account postings outside the exact opening-balance compatibility path.
    def save_historical(txn):
        from moneymap.adapters.sqlite.transactions import _insert_txn
        with conn:
            tid = _insert_txn(conn, txn)
        return txn.model_copy(update={"id": tid})
    cash = account_repo.create(Account(name="현금", type=AccountType.ASSET))
    other = account_repo.create(Account(name="예금", type=AccountType.ASSET))
    opening = account_repo.find_by_name(OPENING_BALANCE_ACCOUNT_NAME)
    save_historical(
        Transaction(
            scenario_id=ACTUAL_SCENARIO_ID,
            date=D(2026, 8, 2),
            postings=[
                Posting(account_id=cash.id, amount=Money(amount=1000)),
                Posting(account_id=other.id, amount=Money(amount=-100)),
                Posting(account_id=opening.id, amount=Money(amount=-900)),
            ],
        )
    )
    assert txn_repo.find_opening_balances() == []


def test_opening_matcher_excludes_wrong_scenario_source_zero_and_equity(conn):
    account_repo = SqliteAccountRepository(conn)
    txn_repo = SqliteTransactionRepository(conn)
    # Historical shapes remain readable even though ordinary input now rejects
    # system-account postings outside the exact opening-balance compatibility path.
    def save_historical(txn):
        from moneymap.adapters.sqlite.transactions import _insert_txn
        with conn:
            tid = _insert_txn(conn, txn)
        return txn.model_copy(update={"id": tid})
    cash = account_repo.create(Account(name="현금", type=AccountType.ASSET))
    food = account_repo.create(Account(name="식비", type=AccountType.EXPENSE))
    ordinary_equity = account_repo.create(
        Account(name="일반 자본", type=AccountType.EQUITY)
    )
    other_system_equity = account_repo.create(
        Account(name="기타 시스템 자본", type=AccountType.EQUITY, is_system=True)
    )
    opening = account_repo.find_by_name(OPENING_BALANCE_ACCOUNT_NAME)

    rule = SqliteRecurringRuleRepository(conn).save(
        RecurringRule(
            scenario_id=ACTUAL_SCENARIO_ID,
            from_account_id=cash.id,
            to_account_id=food.id,
            amount=Money(amount=1000),
            schedule=Schedule(spec="monthly:1"),
            start_date=D(2026, 8, 1),
        )
    )
    save_historical(
        Transaction(
            scenario_id=ACTUAL_SCENARIO_ID,
            source_rule_id=rule.id,
            date=D(2026, 8, 1),
            postings=[
                Posting(account_id=cash.id, amount=Money(amount=1000)),
                Posting(account_id=opening.id, amount=Money(amount=-1000)),
            ],
        )
    )

    scenario = SqliteScenarioRepository(conn).save(
        Scenario(
            name="가설", base_scenario_id=ACTUAL_SCENARIO_ID, fork_date=D(2026, 8, 1)
        )
    )
    save_historical(
        Transaction(
            scenario_id=scenario.id,
            date=D(2026, 8, 1),
            postings=[
                Posting(account_id=cash.id, amount=Money(amount=2000)),
                Posting(account_id=opening.id, amount=Money(amount=-2000)),
            ],
        )
    )

    save_historical(
        Transaction(
            scenario_id=ACTUAL_SCENARIO_ID,
            date=D(2026, 8, 2),
            postings=[
                Posting(account_id=cash.id, amount=Money(amount=3000)),
                Posting(account_id=ordinary_equity.id, amount=Money(amount=-3000)),
            ],
        )
    )
    save_historical(
        Transaction(
            scenario_id=ACTUAL_SCENARIO_ID,
            date=D(2026, 8, 2),
            postings=[
                Posting(account_id=cash.id, amount=Money(amount=4000)),
                Posting(account_id=other_system_equity.id, amount=Money(amount=-4000)),
            ],
        )
    )

    conn.execute(
        "INSERT INTO transactions (scenario_id, date, posted) VALUES (?, '2026-08-03', 0)",
        (ACTUAL_SCENARIO_ID,),
    )
    zero_txn_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (?, ?, 0)",
        (zero_txn_id, cash.id),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (?, ?, 0)",
        (zero_txn_id, opening.id),
    )
    conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (zero_txn_id,))
    conn.commit()

    assert txn_repo.find_opening_balances() == []


# ─── 거래 저장 + 트리거 백스톱 ───────────────────────────


def test_transaction_roundtrip(conn, accounts):
    repo = SqliteTransactionRepository(conn)
    saved = repo.save(
        expense_txn(
            ACTUAL_SCENARIO_ID,
            D(2026, 7, 5),
            accounts["food"].id,
            accounts["card"].id,
            52_000,
        )
    )
    assert saved.id is not None
    loaded = repo.find_by_scenario(ACTUAL_SCENARIO_ID)
    assert len(loaded) == 1
    assert loaded[0].postings == saved.postings


def test_trigger_rejects_unbalanced_raw_sql(conn, accounts):
    """도메인을 우회한 raw SQL도 트리거가 막는다 (이중 enforce의 존재 이유)."""
    conn.execute(
        "INSERT INTO transactions (id, scenario_id, date, posted) VALUES (100, ?, '2026-07-05', 0)",
        (ACTUAL_SCENARIO_ID,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (100, ?, 52000)",
        (accounts["food"].id,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (100, ?, -50000)",
        (accounts["card"].id,),
    )
    with pytest.raises(sqlite3.IntegrityError, match="차변=대변"):
        conn.execute("UPDATE transactions SET posted=1 WHERE id=100")
    conn.rollback()


def test_trigger_rejects_mixed_currency_raw_sql(conn, accounts):
    conn.execute(
        "INSERT INTO transactions (id, scenario_id, date, posted) VALUES (101, ?, '2026-07-05', 0)",
        (ACTUAL_SCENARIO_ID,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) VALUES (101, ?, 100, 'USD')",
        (accounts["food"].id,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount, currency) VALUES (101, ?, -100, 'KRW')",
        (accounts["card"].id,),
    )
    with pytest.raises(sqlite3.IntegrityError, match="단일 통화"):
        conn.execute("UPDATE transactions SET posted=1 WHERE id=101")
    conn.rollback()


def test_trigger_blocks_tampering_posted_txn(conn, accounts):
    repo = SqliteTransactionRepository(conn)
    saved = repo.save(
        expense_txn(
            ACTUAL_SCENARIO_ID,
            D(2026, 7, 5),
            accounts["food"].id,
            accounts["card"].id,
            10_000,
        )
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE postings SET amount=999 WHERE txn_id=?", (saved.id,))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM postings WHERE txn_id=?", (saved.id,))


def test_unposted_transactions_invisible(conn, accounts):
    """posted=0(부분 쓰기)은 조회·잔액 어디에도 안 보인다."""
    conn.execute(
        "INSERT INTO transactions (id, scenario_id, date, posted) VALUES (102, ?, '2026-07-05', 0)",
        (ACTUAL_SCENARIO_ID,),
    )
    conn.execute(
        "INSERT INTO postings (txn_id, account_id, amount) VALUES (102, ?, 77000)",
        (accounts["food"].id,),
    )
    assert SqliteTransactionRepository(conn).find_by_scenario(ACTUAL_SCENARIO_ID) == []
    bal = SqliteLedgerQueries(conn).balance_at(
        accounts["food"].id, D(2026, 12, 31), ACTUAL_SCENARIO_ID
    )
    assert bal.amount == 0


# ─── 잔액 (fold 의미론, depth-1) ─────────────────────────


def test_balance_at_actual(conn, accounts):
    repo = SqliteTransactionRepository(conn)
    q = SqliteLedgerQueries(conn)
    food, card = accounts["food"].id, accounts["card"].id
    repo.save(expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 1), food, card, 10_000))
    repo.save(expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 10), food, card, 20_000))

    assert q.balance_at(food, D(2026, 7, 5), ACTUAL_SCENARIO_ID).amount == 10_000
    assert q.balance_at(food, D(2026, 7, 31), ACTUAL_SCENARIO_ID).amount == 30_000
    assert q.balance_at(card, D(2026, 7, 31), ACTUAL_SCENARIO_ID).amount == -30_000
    # 자산=부채+자본 검산: 전체 posting 합은 항상 0
    total = conn.execute(
        "SELECT COALESCE(SUM(p.amount),0) AS s FROM postings p"
        " JOIN transactions t ON t.id=p.txn_id WHERE t.posted=1"
    ).fetchone()["s"]
    assert total == 0


def test_balance_at_scenario_fork_boundary(conn, accounts):
    """fork 경계 (D2/D7-B 정밀 규칙):

    actual 쪽: date < fork 포함 + date = fork 인 '수동 입력' 포함,
               date = fork 인 '규칙 생성분' 제외 (시뮬레이션과 이중 계상 방지),
               date > fork 제외.
    시나리오 쪽: fork ≤ date ≤ T 포함.
    """
    txn_repo = SqliteTransactionRepository(conn)
    q = SqliteLedgerQueries(conn)
    food, card = accounts["food"].id, accounts["card"].id
    fork = D(2026, 7, 10)

    # fork 당일 규칙 생성분을 만들기 위한 규칙 (FK용)
    rule = SqliteRecurringRuleRepository(conn).save(
        RecurringRule(
            scenario_id=ACTUAL_SCENARIO_ID,
            description="월세",
            from_account_id=card,
            to_account_id=food,
            amount=Money(amount=777_777),
            schedule=Schedule(spec="monthly:10"),
            start_date=D(2026, 7, 1),
        )
    )

    txn_repo.save(
        expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 5), food, card, 10_000)
    )  # fork 전 → 포함
    txn_repo.save(
        expense_txn(ACTUAL_SCENARIO_ID, fork, food, card, 30_000)
    )  # fork 당일 수동 → 포함
    rule_txn = expense_txn(ACTUAL_SCENARIO_ID, fork, food, card, 777_777)
    txn_repo.save(
        rule_txn.model_copy(update={"source_rule_id": rule.id})
    )  # fork 당일 규칙 생성 → 제외
    txn_repo.save(
        expense_txn(ACTUAL_SCENARIO_ID, D(2026, 7, 20), food, card, 888_888)
    )  # fork 후 actual → 제외

    sc = SqliteScenarioRepository(conn).save(
        Scenario(name="가설", base_scenario_id=ACTUAL_SCENARIO_ID, fork_date=fork)
    )
    txn_repo.save(
        expense_txn(sc.id, fork, food, card, 5_000)
    )  # 시나리오, fork 당일 → 포함
    txn_repo.save(
        expense_txn(sc.id, D(2026, 8, 1), food, card, 7_000)
    )  # 시나리오, T 이후 → 제외(T=7/31)

    bal = q.balance_at(food, D(2026, 7, 31), sc.id)
    assert bal.amount == 10_000 + 30_000 + 777_777

    # actual_base_net_worth: 시뮬 시작 순자산도 같은 경계 규칙 (지출은 자산·부채 합에 −)
    assert q.actual_base_net_worth(fork) == -(10_000 + 30_000 + 777_777)


# ─── 반복 규칙 ───────────────────────────────────────────


def test_recurring_rule_roundtrip(conn, accounts):
    repo = SqliteRecurringRuleRepository(conn)
    rule = repo.save(
        RecurringRule(
            scenario_id=ACTUAL_SCENARIO_ID,
            description="월세",
            from_account_id=accounts["toss"].id,
            to_account_id=accounts["food"].id,
            amount=Money(amount=800_000),
            schedule=Schedule(spec="monthly:1"),
            start_date=D(2026, 7, 1),
        )
    )
    assert rule.id is not None
    loaded = repo.find_by_scenario(ACTUAL_SCENARIO_ID)
    assert loaded == [rule]
