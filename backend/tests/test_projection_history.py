"""Actual history has an explicit as-of endpoint, without future postings."""
import datetime as dt
import pytest
from moneymap.adapters.sqlite import connect
from moneymap.adapters.sqlite.projection import ProjectionInputReader
import test_scenario_lifecycle as lifecycle

client = lifecycle.client
TODAY = dt.datetime(2026, 10, 25, 9, tzinfo=dt.timezone(dt.timedelta(hours=9)))

@pytest.mark.parametrize("last_day", ["2026-10-24", "2026-10-25"])
def test_dashboard_actual_reaches_as_of_without_duplicate_or_future_points(client, monkeypatch, last_day):
    import moneymap.adapters.sqlite.projection as reader_module
    monkeypatch.setattr(reader_module, "now", lambda: TODAY)
    bank = lifecycle.account(client, "Bank", "asset")
    income = lifecycle.account(client, "Income", "income")
    for day, amount in [(last_day, -1000), ("2026-10-26", 9000)]:
        result = client.post("/api/transactions", json={"date": day, "postings": [
            {"account_id": bank, "amount": amount}, {"account_id": income, "amount": -amount}]})
        assert result.status_code == 201, result.text
    result = client.get("/api/dashboard-projection?months=3")
    assert result.status_code == 200, result.text
    actual, baseline = result.json()["series"]
    assert actual["points"][-1] == {"date": "2026-10-25", "net_worth": -1000}
    assert sum(p["date"] == "2026-10-25" for p in actual["points"]) == 1
    assert all(p["date"] <= "2026-10-25" for p in actual["points"])
    assert baseline["points"][0] == actual["points"][-1]
    assert len(actual["points"]) == (2 if last_day < "2026-10-25" else 1)


def test_empty_history_does_not_invent_a_record_and_historical_cutoff_is_respected(client):
    conn = connect(client.app.state.db_path)
    try:
        assert ProjectionInputReader(conn).actual_history("2026-10-25") == []
    finally:
        conn.close()
    bank = lifecycle.account(client, "Bank", "asset")
    income = lifecycle.account(client, "Income", "income")
    for day, amount in [("2026-09-30", 500), ("2026-10-25", 200)]:
        assert client.post("/api/transactions", json={"date": day, "postings": [
            {"account_id": bank, "amount": amount}, {"account_id": income, "amount": -amount}]}).status_code == 201
    conn = connect(client.app.state.db_path)
    try:
        assert ProjectionInputReader(conn).actual_history("2026-10-01") == [
            {"date": "2026-09-30", "net_worth": 500}, {"date": "2026-10-01", "net_worth": 500}]
    finally:
        conn.close()
