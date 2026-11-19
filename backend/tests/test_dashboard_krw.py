"""The dashboard and statistics must agree after migrating a mixed-currency ledger."""
import datetime as dt
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from moneymap.adapters.sqlite import connect, database, init_db, SqliteAccountRepository
from moneymap.adapters.sqlite.rules import ScenarioRuleWriter
from moneymap.adapters.sqlite.transactions import _insert_txn
from moneymap.api import create_app
from moneymap.domain import Account, Money, Posting, RecurringRule, Schedule, Transaction


def seed_v8(path, today, mixed):
    conn = connect(str(path))
    with patch.object(database, "MIGRATIONS", database.MIGRATIONS[:8]):
        init_db(conn)
    accounts = SqliteAccountRepository(conn)
    bank, income, expense, dollar = [
        accounts.create(Account(name=name, type=kind, currency=currency)).id
        for name, kind, currency in [("Bank", "asset", "KRW"), ("Income", "income", "KRW"),
                                     ("Expense", "expense", "KRW"), ("Dollar", "asset", "USD")]
    ]

    def post(name, currency, *legs):
        with conn:
            _insert_txn(conn, Transaction(
                date=today, description=name, scenario_id=1,
                postings=[Posting(account_id=aid, amount=Money(amount=n, currency=currency)) for aid, n in legs],
            ))

    post("salary", "KRW", (bank, 1000), (income, -1000))
    post("meal", "KRW", (expense, 300), (bank, -300))
    post("refund", "KRW", (expense, -50), (bank, 50))
    tomorrow = today + dt.timedelta(days=1)
    rules = ScenarioRuleWriter(conn)
    def rule(name, target, amount, currency):
        with conn:
            conn.execute("BEGIN")
            rules.save(RecurringRule(scenario_id=1, description=name, from_account_id=income,
                to_account_id=target, amount=Money(amount=amount, currency=currency),
                schedule=Schedule(spec=f"monthly:{tomorrow.day}"), start_date=tomorrow, end_date=tomorrow))

    rule("won rule", bank, 80, "KRW")
    if mixed:
        post("dollar salary", "USD", (bank, 1234), (income, -1234))
        post("dollar meal", "USD", (expense, 375), (bank, -375))
        post("dollar refund", "USD", (expense, -100), (bank, 100))
        post("mismatched split", "KRW", (bank, 60), (dollar, 40), (income, -100))
        rule("dollar rule", bank, 1234, "USD")
        rule("mismatched rule", dollar, 700, "KRW")
    conn.close()
    return bank


@pytest.mark.parametrize("mixed", [False, True])
def test_migrated_dashboard_includes_only_whole_krw_transactions_and_rules(tmp_path, mixed):
    from moneymap.app_services.scenarios import now
    today = now().date()
    path = tmp_path / "dashboard.db"
    bank = seed_v8(path, today, mixed)
    with TestClient(create_app(str(path))) as client:
        stats = client.get("/api/statistics", params={"start": today, "end": today}).json()
        assert [stats["summary"][key] for key in ("income", "expense", "net_income")] == [1000, 250, 750]
        balances = client.get("/api/balances?krw_only=true").json()
        assert balances["net_worth"] == str(stats["summary"]["net_worth"]) == "750"
        assert next(row for row in balances["accounts"] if row["account_id"] == bank)["balance"] == "750"
        assert client.get("/api/balances?krw_only=true&scenario_id=2").status_code == 422
        actual, forecast = client.get("/api/dashboard-projection?months=3").json()["series"]
        assert actual["points"][-1]["net_worth"] == forecast["points"][0]["net_worth"] == 750
        assert forecast["points"][-1]["net_worth"] == 830
        ordinary = client.get("/api/projection?scenario_id=1&months=3").json()
        points = ordinary["net_worth"]["baseline"]["points"]
        assert (points[0]["balance"], points[-1]["balance"]) == (750, 830)
        if mixed:
            rows = client.get("/api/transaction-history", params={
                "start": today, "end": today, "account_id": bank}).json()["items"]
            foreign = next(row for row in rows if row["description"] == "dollar salary")
            assert foreign["postings"][0]["amount"] == {"amount": 1234, "currency": "USD"}
            assert {"amount": "1234", "currency": "USD"} in foreign["balance_after"]


def test_two_safe_deposits_return_exact_stock_and_identify_unrepresentable_curves(tmp_path):
    from moneymap.app_services.scenarios import now
    day = now().date().isoformat()
    with TestClient(create_app(str(tmp_path / "large.db"))) as client:
        bank, income = [client.post("/api/accounts", json={"name": kind, "type": kind}).json()["id"]
                        for kind in ("asset", "income")]
        for amount in [2, 2**53 - 1]:
            response = client.post("/api/transactions", json={"date": day, "postings": [
                {"account_id": bank, "amount": amount}, {"account_id": income, "amount": -amount}]})
            assert response.status_code == 201
        balances = client.get("/api/balances?krw_only=true").json()
        assert balances["net_worth"] == "9007199254740993"
        assert next(row["balance"] for row in balances["accounts"] if row["account_id"] == bank) == balances["net_worth"]
        assert client.get("/api/balances").json()["net_worth"] == 9007199254740993
        projection = client.get("/api/dashboard-projection?months=3").json()
        assert projection["series"] == []
        assert [message.split(":")[0] for message in projection["warnings"]] == ["실제", "현재 패턴 유지"]
