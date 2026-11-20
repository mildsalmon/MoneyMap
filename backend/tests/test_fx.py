from contextlib import closing
from datetime import date
from uuid import uuid4


from moneymap.adapters.sqlite import connect, database, SqliteLedgerQueries
from test_api import client, make_account
from test_balance_history import insert

DAY = "2026-06-10"
REPORT = f"/api/fx?day={DAY}"


def buy(bank, **extra):
    return (
        dict(
            currency="USD",
            side="buy",
            day=DAY,
            quantity="10.25",
            cash="14450",
            fee="100",
            rate="1400",
            rate_date=DAY,
            source="합성 명세서",
            bank_id=bank,
        )
        | extra
    )


def cmd(trade, **kwargs):
    return dict(request_id=str(uuid4()), trade=trade) | kwargs


def test_roundtrip_and_backdated_atomicity(client):
    bank = make_account(client, "검산 통장", "asset")
    first = cmd(buy(bank))
    tid = client.post("/api/fx/trades", json=first).json()["id"]
    assert client.post("/api/fx/trades", json=first).json() == {"id": tid}
    assert (
        client.post(
            "/api/fx/trades", json=first | {"trade": buy(bank, cash="1")}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/fx/trades", json=first | {"trade": buy(bank, quantity="1")}
        ).status_code
        == 409
    )
    r = client.get(REPORT).json()
    assert (r["missing"], r["foreign_subtotal"], r["krw"]) == (1, "0", "-14450")
    stats = client.get(f"/api/statistics?start={DAY}&end={DAY}").json()
    assert (
        stats["summary"]["expense"] == 100 and stats["excluded_transaction_count"] == 1
    )
    history = client.get(
        "/api/transaction-history", params={"start": DAY, "end": DAY}
    ).json()["items"]
    assert len(history) == 2 and all(t["fx_id"] == tid for t in history)
    row = r["trades"][0]
    for leg in (row["native_txn"], row["krw_txn"]):
        assert client.delete(f"/api/transactions/{leg}").status_code == 409
    quote = dict(rate_date=DAY, rate="1410", source="수동 종가", currency="USD")
    assert client.put("/api/fx/quotes", json=quote).is_success
    r = client.get(REPORT).json()
    b = r["balances"][0]
    assert (b["minor"], b["value"], b["unrealized"], b["cost"], b["fees"]) == (
        "1025",
        "14453",
        "103",
        "14350",
        "100",
    )
    assert r["valued_net"] == "3"
    with closing(connect(client.app.state.db_path)) as conn:
        queries = SqliteLedgerQueries(conn)
        day = date.fromisoformat(DAY)
        original = queries.balance_at(b["account_id"], day, 1)
        assert (original.amount, original.currency) == (1025, "USD")
        assert (
            queries.actual_base_net_worth(day) == queries.net_worth_at(day, 1) == -14450
        )
    assert client.get("/api/fx?day=2026-06-11").json()["missing"] == 1
    assert client.get("/api/fx?day=2026-06-09").json()["balances"] == []
    sell = buy(bank, side="sell", cash="14555", fee="0", rate="1420")
    assert client.post("/api/fx/trades", json=cmd(sell)).is_success
    edit = cmd(buy(bank, quantity="9.25"), expected_version=1)
    assert client.put(f"/api/fx/trades/{tid}", json=edit).status_code == 409
    b = client.get(REPORT).json()["balances"][0]
    assert (b["minor"], b["realized"], b["unrealized"], b["cost"]) == (
        "0",
        "205",
        "0",
        "0",
    )
    assert (
        client.put(
            f"/api/fx/trades/{tid}", json=cmd(buy(bank), expected_version=0)
        ).status_code
        == 409
    )


def test_moving_average_and_partial_sale(client):
    bank = make_account(client, "통장", "asset")
    for qty, cash in [("2", "2000"), ("1", "2500")]:
        assert client.post(
            "/api/fx/trades", json=cmd(buy(bank, quantity=qty, cash=cash, fee="0"))
        ).is_success
    sell = buy(bank, quantity="1", side="sell", cash="1660", fee="40")
    assert client.post("/api/fx/trades", json=cmd(sell)).is_success
    b = client.get(REPORT).json()["balances"][0]
    assert (b["minor"], b["cost"], b["realized"], b["fees"]) == (
        "200",
        "3000",
        "200",
        "40",
    )
    assert (
        client.post(
            "/api/fx/trades", json=cmd(buy(bank, quantity="1.01", currency="JPY"))
        ).status_code
        == 422
    )


def originals(conn):
    return [
        [
            tuple(r)
            for r in conn.execute(f"SELECT * FROM {table} WHERE {key}<=8 ORDER BY 1")
        ]
        for table, key in (
            ("transactions", "id"),
            ("postings", "txn_id"),
            ("transaction_import_provenance", "txn_id"),
        )
    ]


def test_selected_v15_rows_preview_verified_backup_and_lineage(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from moneymap.api import create_app
    from moneymap.adapters.sqlite import fx_legacy

    path = tmp_path / "synthetic.db"
    with monkeypatch.context() as patch:
        patch.setattr(database, "MIGRATIONS", database.MIGRATIONS[:15])
        with TestClient(create_app(str(path))) as old:
            bank = make_account(old, "통장", "asset")
            expense = make_account(old, "원화에서달러로환전", "expense")
            with closing(connect(str(path))) as c, c:
                for n in range(8):
                    tid = insert(c, [expense, bank], 14450, DAY)
                    c.execute(
                        """INSERT INTO transaction_import_provenance
                        (txn_id,source_hash,source_file,source_row,raw_date,raw_description,raw_amount,raw_running_total,
                        raw_left_type,raw_left_account,raw_right_type,raw_right_account)
                        VALUES(?,?,'synthetic.csv',?,?, 'USD','14450','0','비용','원화에서달러로환전','자산','통장')""",
                        (tid, "a" * 64, n + 2, DAY),
                    )
                prior = originals(c)
    with TestClient(create_app(str(path))) as app, closing(connect(str(path))) as c:
        assert originals(c) == prior
        assert len(app.get("/api/fx/legacy").json()) == 8
        s = dict(transaction_id=2, trade=buy(bank))
        url = "/api/fx/legacy"
        assert (
            app.post(
                url + "/preview", json=s | {"trade": buy(bank, cash="14500")}
            ).status_code
            == 400
        )
        p = app.post(url + "/preview", json=s).json()
        assert p["before"]["bank"] == p["after"]["bank"] == str(-14450 * 8)
        assert p["after"]["holding"] == "1025" and p["after"]["fee"] == "100"
        assert c.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 8
        apply = s | {"preview_hash": p["preview_hash"]}
        assert (
            app.post(
                url + "/apply", json=apply | {"preview_hash": "0" * 64}
            ).status_code
            == 409
        )
        with monkeypatch.context() as patch:

            def fail(*args):
                raise OSError("synthetic backup failure")

            patch.setattr(fx_legacy, "run_import_backup", fail)
            assert app.post(url + "/apply", json=apply).status_code == 503
        assert originals(c) == prior
        receipt = app.post(url + "/apply", json=apply)
        assert receipt.is_success, receipt.text
        assert app.post(url + "/apply", json=apply).json() == receipt.json()
        assert (
            app.post(
                url + "/apply", json=apply | {"trade": buy(bank, rate="1300")}
            ).status_code
            == 409
        )
        assert len(app.get(url).json()) == 7
        trade = app.get(REPORT).json()["trades"][0]
        assert (trade["source_row"], trade["source_hash"], trade["legacy_txn"]) == (
            3,
            "a" * 64,
            2,
        )
        assert originals(c) == prior
        with closing(connect(str(path.parent / "backups" / trade["backup"]))) as backup:
            assert (
                originals(backup) == prior
                and not backup.execute("SELECT id FROM fx_trades").fetchall()
            )
        assert [
            tuple(r)
            for r in c.execute(
                "SELECT currency,sum(amount) FROM postings GROUP BY currency ORDER BY currency"
            )
        ] == [("KRW", 0), ("USD", 0)]
        assert app.delete("/api/transactions/2").status_code == 409


def test_candidate_uses_imported_row_after_accounts_are_renamed(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from moneymap import legacy_import
    from moneymap.api import create_app
    from test_api import update_settings

    path = tmp_path / "synthetic.db"
    source = tmp_path / "statement.csv"
    source.write_text(
        "날짜,내역,금액,누계,왼쪽유형,왼쪽계정,오른쪽유형,오른쪽계정,메모\n"
        f"{DAY},USD 구매,14450,14450,비용,원화에서달러로환전,자산,현금,\n"
        f"{DAY},운임,14450,28900,비용,기타지출,자산,현금,\n",
        encoding="utf-8",
    )
    (tmp_path / "csv-expense-default-classification-review-20260906.csv").write_text(
        "원본 행,연결 계정\n", encoding="utf-8"
    )
    with monkeypatch.context() as patch:
        patch.setattr(database, "MIGRATIONS", database.MIGRATIONS[:15])
        patch.setattr(
            legacy_import, "LOCAL_CORRECTIONS", tmp_path / "no-corrections.json"
        )
        with TestClient(create_app(str(path))), closing(connect(str(path))) as conn:
            legacy_import.import_legacy_csv(
                conn, source, tmp_path, apply=True, expected_hash=None
            )
    with TestClient(create_app(str(path))) as app, closing(connect(str(path))) as conn:
        url = "/api/fx/legacy"
        [purchase] = app.get(url).json()
        assert purchase["source_row"] == 2
        freight = conn.execute(
            "SELECT txn_id FROM transaction_import_provenance WHERE source_row=3"
        ).fetchone()[0]
        other = conn.execute(
            "SELECT id FROM accounts WHERE name='기타지출'"
        ).fetchone()[0]
        assert update_settings(
            app, purchase["expense_id"], name="달러 매수비"
        ).is_success
        assert update_settings(app, other, name="원화에서달러로환전").is_success
        rows = [r["source_row"] for r in app.get(url).json()]
        snapshot = list(conn.iterdump())
        backups = set((tmp_path / "backups").iterdir())
        valid = {
            "transaction_id": purchase["transaction_id"],
            "trade": buy(purchase["bank_id"]),
        }
        wrong = valid | {"transaction_id": freight}
        preview = app.post(url + "/preview", json=wrong)
        # On the buggy head even its server-issued preview token confirms the freight.
        receipt = app.post(
            url + "/apply",
            json=wrong | {"preview_hash": preview.json().get("preview_hash", "0" * 64)},
        )
        assert (rows, preview.status_code, receipt.status_code) == ([2], 409, 409)
        assert receipt.json()["detail"] == preview.json()["detail"]
        assert list(conn.iterdump()) == snapshot
        assert set((tmp_path / "backups").iterdir()) == backups
        before = [
            tuple(r)
            for r in conn.execute(
                "SELECT * FROM transaction_import_provenance ORDER BY source_row"
            )
        ]
        postings = [
            tuple(r) for r in conn.execute("SELECT * FROM postings ORDER BY id")
        ]
        impact = app.post(url + "/preview", json=valid).json()
        assert impact["before"]["bank"] == impact["after"]["bank"] == "-28900"
        assert app.post(
            url + "/apply", json=valid | {"preview_hash": impact["preview_hash"]}
        ).is_success
        assert [
            tuple(r)
            for r in conn.execute(
                "SELECT * FROM transaction_import_provenance ORDER BY source_row"
            )
        ] == before
        assert [
            tuple(r)
            for r in conn.execute(
                "SELECT * FROM postings WHERE txn_id IN (?,?) ORDER BY id",
                (valid["transaction_id"], freight),
            )
        ] == postings
        assert [
            tuple(r)
            for r in conn.execute(
                "SELECT currency,sum(amount) FROM postings GROUP BY currency ORDER BY currency"
            )
        ] == [("KRW", 0), ("USD", 0)]

        # An existing receipt also requires an identifiable source row.
        with conn:
            conn.execute(
                "UPDATE transaction_import_provenance SET source_file='' WHERE source_row=2"
            )
        snapshot = list(conn.iterdump())
        assert (
            app.post(
                url + "/apply", json=valid | {"preview_hash": impact["preview_hash"]}
            ).status_code
            == 409
        )
        assert list(conn.iterdump()) == snapshot
