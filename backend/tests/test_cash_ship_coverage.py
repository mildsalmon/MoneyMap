"""Ship coverage for liquidity ties and cash-settings atomic failure."""

import sqlite3

import pytest

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite.accounts import SqliteAccountRepository
from moneymap.domain import Account, AccountSettingsCommand, AccountType
from moneymap.domain.projection import fold_projection
from test_scenario_liquidity import event, inputs


def test_equal_cash_minima_keep_first_date_after_recovery():
    result = fold_projection(
        inputs(events=[event(2, -150, 1), event(3, 50, 2), event(4, -50, 3)]),
        3,
    )["cash"]["scenario"]["shortage"]
    assert result["maximum_shortage"] == {"date": "2026-02-02", "balance": -50}
    assert result["first_shortage"]["end"] == "2026-02-02"
    assert result["first_shortage"]["days"] == 1


@pytest.mark.parametrize("selected", [False, True])
def test_cash_settings_failure_rolls_back_revision_and_all_account_fields(
    tmp_path, selected
):
    conn = connect(str(tmp_path / "cash-write.db"))
    try:
        init_db(conn)
        repo = SqliteAccountRepository(conn)
        bank = repo.create(
            Account(name="bank", type=AccountType.ASSET, include_in_cash=selected)
        )
        command = AccountSettingsCommand(
            account_id=bank.id,
            name="renamed bank",
            parent_id=None,
            is_overdraft=False,
            include_in_cash=not selected,
            version=bank.version,
        )
        before_accounts = [tuple(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")]
        before_revision = tuple(conn.execute("SELECT * FROM calculation_revisions").fetchone())
        conn.execute(
            "CREATE TRIGGER fail_cash_revision AFTER UPDATE OF cash_config_revision "
            "ON calculation_revisions BEGIN SELECT RAISE(ABORT, 'cash revision failure'); END"
        )
        with pytest.raises(sqlite3.IntegrityError, match="cash revision failure"):
            repo.update_settings(command)
        assert not conn.in_transaction
        assert [tuple(r) for r in conn.execute("SELECT * FROM accounts ORDER BY id")] == before_accounts
        assert tuple(conn.execute("SELECT * FROM calculation_revisions").fetchone()) == before_revision
        conn.execute("DROP TRIGGER fail_cash_revision")
        saved = repo.update_settings(command).account
        assert saved.include_in_cash is not selected
        assert saved.name == "renamed bank" and saved.version == bank.version + 1
        assert conn.execute(
            "SELECT cash_config_revision FROM calculation_revisions"
        ).fetchone()[0] == before_revision[-1] + 1
    finally:
        conn.close()
