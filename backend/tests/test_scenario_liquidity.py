"""PR4 hand-calculated liquidity and cash-account invariant gates."""

import datetime as dt
import sqlite3
from dataclasses import replace

import pytest
from hypothesis import given, strategies as st

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite import database
from moneymap.adapters.sqlite.accounts import SqliteAccountRepository
from moneymap.domain import Account, AccountType, AccountSettingsCommand
from moneymap.domain.errors import DomainConflictError
from moneymap.domain.projection import (
    ProjectionInputs,
    ProjectionEvent,
    fold_projection,
)
from moneymap.domain.scenario import Scenario
from moneymap.domain.standard_accounts import StandardAccount
import test_scenario_lifecycle as lifecycle

client = lifecycle.client
FORK = dt.date(2026, 1, 31)


def inputs(opening=100, events=(), cash=(1,)):
    return ProjectionInputs(
        Scenario(id=2, name="plan", base_scenario_id=1, fork_date=FORK),
        1,
        1,
        ((1, "asset"), (2, "asset"), (3, "expense")),
        ((1, opening),),
        (),
        (),
        tuple(events),
        cash,
        7,
    )


def event(day, amount, id=1, target=3):
    return ProjectionEvent(
        dt.date(2026, 2, day),
        "planned_transaction",
        id,
        f"item {id}",
        "scenario",
        ((1, amount), (target, -amount)),
    )


def test_shortage_golden_recovery_and_later_maximum():
    result = fold_projection(
        inputs(
            events=[
                event(2, -150, 2),
                event(2, 10, 1),
                event(5, 40, 3),
                event(9, -90, 4),
            ]
        ),
        3,
    )
    cash = result["cash"]
    assert cash["baseline"]["shortage"] is None
    assert cash["scenario"]["shortage"] == {
        "first_shortage": {
            "start": "2026-02-02",
            "end": "2026-02-04",
            "days": 3,
            "through_horizon": False,
            "triggering_items": [
                {"kind": "planned_transaction", "id": 1, "label": "item 1"},
                {"kind": "planned_transaction", "id": 2, "label": "item 2"},
            ],
        },
        "maximum_shortage": {"date": "2026-02-09", "balance": -90},
    }
    assert cash["scenario"]["points"][-1] == {"date": "2026-04-30", "balance": -90}
    assert result["basis"]["cash_config_revision"] == 7


@pytest.mark.parametrize("recovery", [False, True])
def test_negative_opening(recovery):
    value = fold_projection(inputs(-10, [event(1, 10)] if recovery else []), 3)["cash"][
        "scenario"
    ]["shortage"]
    assert value["first_shortage"] == {
        "start": "2026-01-31",
        "end": "2026-01-31" if recovery else None,
        "days": 1 if recovery else 90,
        "through_horizon": not recovery,
        "triggering_items": [],
        "reason": "negative_start_balance",
    }
    assert value["maximum_shortage"] == {"date": "2026-01-31", "balance": -10}


def test_same_day_recovery_has_no_intraday_shortage_and_terminal_zero():
    result = fold_projection(inputs(events=[event(1, -200, 1), event(1, 200, 2)]), 3)
    assert result["cash"]["scenario"]["shortage"] is None
    assert len(result["cash"]["scenario"]["points"]) == 2


def test_unconfigured_omits_curves():
    assert fold_projection(inputs(cash=()), 3)["cash"] == {
        "available": False,
        "reason": "cash_accounts_not_configured",
    }


@given(st.integers(0, 10**12), st.integers(1, 10**12))
def test_selected_transfer_neutrality(opening, amount):
    source = inputs(opening, [event(2, -amount, target=2)], cash=(1, 2))
    result = fold_projection(source, 12)
    assert result["cash"]["scenario"]["points"][-1]["balance"] == opening
    assert result["cash"]["scenario"]["shortage"] is None
    one = fold_projection(replace(source, cash_account_ids=(1,)), 12)
    assert one["cash"]["scenario"]["points"][-1]["balance"] == opening - amount
    assert result["net_worth"] == one["net_worth"]


@pytest.fixture
def repo(tmp_path):
    conn = connect(str(tmp_path / "cash.db"))
    init_db(conn)
    yield SqliteAccountRepository(conn)
    conn.close()


def settings(repo, account, **changes):
    return repo.update_settings(
        AccountSettingsCommand(
            account_id=account.id,
            name=account.name,
            parent_id=changes.pop("parent_id", account.parent_id),
            is_overdraft=account.is_overdraft,
            version=changes.pop("version", account.version),
            **changes,
        )
    ).account


def test_selected_account_writer_matrix_and_revision(repo):
    bank = repo.create(Account(name="bank", type=AccountType.ASSET))
    group = repo.create(
        Account(name="group", type=AccountType.ASSET, is_placeholder=True)
    )
    assert not bank.include_in_cash
    bank = settings(repo, bank, include_in_cash=True)
    assert bank.version == 2
    assert (
        repo._conn.execute(
            "SELECT cash_config_revision FROM calculation_revisions"
        ).fetchone()[0]
        == 2
    )
    for operation, code in [
        (
            lambda: repo.create(
                Account(name="child", type=AccountType.ASSET, parent_id=bank.id)
            ),
            "cash_account_parent_forbidden",
        ),
        (lambda: repo.set_placeholder(bank.id, True), "cash_account_must_be_leaf"),
        (lambda: repo.set_archived(bank.id, True), "cash_account_selected"),
        (
            lambda: settings(repo, group, parent_id=bank.id),
            "cash_account_parent_forbidden",
        ),
        (
            lambda: settings(repo, bank, include_in_cash=False, version=1),
            "account_settings_stale",
        ),
    ]:
        with pytest.raises(DomainConflictError) as caught:
            operation()
        assert caught.value.code == code
        assert repo.find_by_id(bank.id).include_in_cash
    bank = settings(repo, bank, parent_id=group.id)  # omitted field preserves selection
    assert bank.include_in_cash
    assert (
        repo._conn.execute(
            "SELECT cash_config_revision FROM calculation_revisions"
        ).fetchone()[0]
        == 2
    )
    bank = settings(repo, bank, include_in_cash=False)
    assert bank.version == 4
    assert (
        repo._conn.execute(
            "SELECT cash_config_revision FROM calculation_revisions"
        ).fetchone()[0]
        == 3
    )
    assert repo.set_archived(bank.id, True).archived
    assert not repo.set_archived(bank.id, False).archived


@pytest.mark.parametrize(
    "attributes",
    [
        {"type": AccountType.LIABILITY},
        {"type": AccountType.INCOME},
        {"type": AccountType.EXPENSE},
        {"is_placeholder": True},
        {"archived": True},
        {"is_system": True},
    ],
)
def test_invalid_cash_create(repo, attributes):
    with pytest.raises(DomainConflictError, match="현금"):
        repo.create(
            Account(
                **{
                    "name": "bad",
                    "type": AccountType.ASSET,
                    "include_in_cash": True,
                    **attributes,
                }
            )
        )


@pytest.mark.parametrize("archived", [False, True])
def test_children_even_archived_prevent_selection(repo, archived):
    parent = repo.create(Account(name="parent", type=AccountType.ASSET))
    child = repo.create(
        Account(name="child", type=AccountType.ASSET, parent_id=parent.id)
    )
    if archived:
        repo.set_archived(child.id, True)
    with pytest.raises(DomainConflictError) as caught:
        settings(repo, parent, include_in_cash=True)
    assert caught.value.code == "cash_account_must_be_leaf"
    assert not repo.find_by_id(parent.id).include_in_cash


def test_seed_selected_parent_rolls_back(repo):
    parent = repo.create(Account(name="parent", type=AccountType.ASSET))
    settings(repo, parent, include_in_cash=True)
    items = (
        StandardAccount(
            path=("parent", "child"), type=AccountType.ASSET, is_group=False
        ),
    )
    with pytest.raises(DomainConflictError) as caught:
        repo.seed_standard(items)
    assert caught.value.code == "cash_account_parent_forbidden"
    assert repo.find_by_name("child") is None


def test_migration_defaults_backup_idempotence_and_rollback(tmp_path, monkeypatch):
    path = tmp_path / "pr3.db"
    conn = connect(str(path))
    migrations = database.MIGRATIONS
    with monkeypatch.context() as m:
        m.setattr(database, "MIGRATIONS", migrations[:2])
        init_db(conn)
    conn.execute("INSERT INTO accounts(name,type,position) VALUES('bank','asset',1)")
    conn.commit()

    def fail(conn):
        migrations[2](conn)
        raise RuntimeError("injected after DDL")

    with monkeypatch.context() as m:
        m.setattr(database, "MIGRATIONS", (*migrations[:2], fail))
        with pytest.raises(RuntimeError, match="injected"):
            init_db(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    assert "include_in_cash" not in [
        r["name"] for r in conn.execute("PRAGMA table_info(accounts)")
    ]
    init_db(conn)
    assert all(r[0] == 0 for r in conn.execute("SELECT include_in_cash FROM accounts"))
    assert (
        conn.execute(
            "SELECT cash_config_revision FROM calculation_revisions"
        ).fetchone()[0]
        == 1
    )
    backups = list((tmp_path / "backups").glob("migration-*.db"))
    assert backups
    init_db(conn)
    assert list((tmp_path / "backups").glob("migration-*.db")) == backups
    conn.close()


def test_cash_api_snapshot_version_and_eligibility(client):
    sid = lifecycle.create(client)["id"]
    bank = lifecycle.account(client, "bank", "asset")
    before = client.get(f"/api/projection?scenario_id={sid}&months=3").json()
    payload = {
        "name": "bank",
        "parent_id": None,
        "is_overdraft": False,
        "include_in_cash": True,
        "version": 1,
    }
    response = client.put(f"/api/accounts/{bank}/settings", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["account"]["include_in_cash"]
    assert client.put(f"/api/accounts/{bank}/settings", json=payload).status_code == 409
    after = client.get(f"/api/projection?scenario_id={sid}&months=3").json()
    assert not before["cash"]["available"] and after["cash"]["available"]
    assert (
        after["basis"]["cash_config_revision"] > before["basis"]["cash_config_revision"]
    )
    assert after["net_worth"] == before["net_worth"]
    assert client.post(f"/api/accounts/{bank}/archive").status_code == 409


def test_seed_defaults_and_idempotence(repo):
    items = (
        StandardAccount(("seed group",), AccountType.ASSET, True),
        StandardAccount(("seed group", "seed leaf"), AccountType.ASSET),
    )
    assert repo.seed_standard(items) == (2, 0)
    assert repo.seed_standard(items) == (0, 2)
    assert not any(a.include_in_cash for a in repo.find_all())


@pytest.mark.parametrize(
    "sql,code",
    [
        (
            "UPDATE accounts SET is_placeholder=1 WHERE id=?",
            "cash_account_must_be_leaf",
        ),
        ("UPDATE accounts SET archived=1 WHERE id=?", "cash_account_selected"),
        ("UPDATE accounts SET type='expense' WHERE id=?", "cash_account_must_be_leaf"),
        ("UPDATE accounts SET is_system=1 WHERE id=?", "cash_account_must_be_leaf"),
        (
            "INSERT INTO accounts(name,type,parent_id,position) VALUES('child','asset',?,1)",
            "cash_account_parent_forbidden",
        ),
    ],
)
def test_raw_writers_cannot_bypass_cash_invariant(repo, sql, code):
    bank = repo.create(
        Account(name="bank", type=AccountType.ASSET, include_in_cash=True)
    )
    with pytest.raises(sqlite3.IntegrityError, match=code):
        with repo._conn:
            repo._conn.execute(sql, (bank.id,))
    assert repo.find_by_id(bank.id).include_in_cash


def test_restore_guards_selected_parent_even_for_inconsistent_snapshot(
    repo, monkeypatch
):
    parent = repo.create(Account(name="parent", type=AccountType.ASSET))
    child = repo.create(
        Account(name="child", type=AccountType.ASSET, parent_id=parent.id)
    )
    repo.set_archived(child.id, True)
    # A valid DB cannot reach this state; exercise the repository's restore defense.
    original = repo.find_by_id
    monkeypatch.setattr(
        repo,
        "find_by_id",
        lambda aid: parent.model_copy(update={"include_in_cash": True})
        if aid == parent.id
        else original(aid),
    )
    with pytest.raises(DomainConflictError) as caught:
        repo.set_archived(child.id, False)
    assert caught.value.code == "cash_account_parent_forbidden"
    assert original(child.id).archived


def test_rules_and_planned_share_day_trigger_order_and_one_expansion(monkeypatch):
    from moneymap.domain.recurring_rule import RecurringRule
    from moneymap.domain.money import Money
    from moneymap.domain.schedule import Schedule
    import moneymap.domain.projection as projection

    rule = RecurringRule(
        id=5,
        scenario_id=1,
        description="rent",
        from_account_id=1,
        to_account_id=3,
        amount=Money(amount=200),
        schedule=Schedule(spec="monthly:2"),
        start_date=FORK,
        end_date=dt.date(2026, 2, 2),
    )
    source = replace(inputs(events=[event(2, 10, 1)]), actual_rules=(rule,))
    original = projection.expand_events
    calls = []

    def tracked(*args):
        calls.append(1)
        return original(*args)

    monkeypatch.setattr(projection, "expand_events", tracked)
    result = projection.fold_projection(source, 3)
    assert len(calls) == 1
    for key, balance, labels in [
        ("baseline", -100, ["rent"]),
        ("scenario", -90, ["rent", "item 1"]),
    ]:
        shortage = result["cash"][key]["shortage"]
        assert shortage["maximum_shortage"]["balance"] == balance
        assert [
            item["label"] for item in shortage["first_shortage"]["triggering_items"]
        ] == labels
        assert shortage["first_shortage"]["through_horizon"]


@given(st.lists(st.integers(-10000, 10000), min_size=1, max_size=30))
def test_daily_close_permutation_and_baseline_isolation(amounts):
    events = [event(2 + i % 3, amount, i + 1) for i, amount in enumerate(amounts)]
    result = fold_projection(inputs(events=events), 3)
    reordered = fold_projection(inputs(events=list(reversed(events))), 3)
    assert result == reordered
    assert result["cash"]["baseline"]["points"][-1]["balance"] == 100
    assert result["cash"]["scenario"]["points"][-1]["balance"] == 100 + sum(amounts)


def test_cash_configuration_and_revision_share_read_snapshot(client):
    from moneymap.adapters.sqlite.projection import ProjectionInputReader

    sid = lifecycle.create(client)["id"]
    bank = lifecycle.account(client, "snapshot bank", "asset")
    conn = connect(client.app.state.db_path)
    try:
        conn.execute("BEGIN")
        before = ProjectionInputReader(conn).read(sid)
        result = client.put(
            f"/api/accounts/{bank}/settings",
            json={
                "name": "snapshot bank",
                "parent_id": None,
                "is_overdraft": False,
                "include_in_cash": True,
                "version": 1,
            },
        )
        assert result.status_code == 200, result.text
        same = ProjectionInputReader(conn).read(sid)
        assert same.cash_config_revision == before.cash_config_revision
        assert same.cash_account_ids == before.cash_account_ids == ()
        conn.rollback()
        conn.execute("BEGIN")
        latest = ProjectionInputReader(conn).read(sid)
        assert latest.cash_account_ids == (bank,)
        assert latest.cash_config_revision > before.cash_config_revision
    finally:
        conn.rollback()
        conn.close()
