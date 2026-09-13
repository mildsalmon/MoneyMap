"""Ship audit gaps, using only generated CSVs and temporary SQLite files."""
import csv
import sqlite3

import pytest

from moneymap.adapters.sqlite import connect, init_db
from moneymap.adapters.sqlite.backup import run_import_backup
from moneymap import legacy_import as importer
from test_legacy_import import _write_fixture


@pytest.fixture(autouse=True)
def synthetic_corrections_only(tmp_path, monkeypatch):
    monkeypatch.setattr(importer, "LOCAL_CORRECTIONS", tmp_path / "absent-corrections.json")


@pytest.mark.parametrize("case", ["hash", "header", "columns", "date", "amount", "negative", "type", "orphan"])
def test_parser_rejects_unreviewed_or_malformed_source(tmp_path, case):
    source, _ = _write_fixture(tmp_path)
    if case == "hash":
        with pytest.raises(ValueError, match="SHA-256"):
            importer.parse_legacy_csv(source, expected_hash="0" * 64)
        return
    header = ["column"] * 9
    row = ["2026-01-01", "synthetic", "100", "100", "비용", "식비", "자산", "현금", ""]
    if case == "header": header.pop()
    if case == "columns": row.pop()
    if case == "date": row[0] = "2026-02-30"
    if case == "amount": row[2] = "not-an-integer"
    if case == "negative": row[2] = "-100"
    if case == "type": row[4] = "unknown"
    if case == "orphan": row = ["멘토링"]
    with source.open("w", encoding="utf-8", newline="") as stream:
        csv.writer(stream).writerows([header, row])
    with pytest.raises(ValueError):
        importer.parse_legacy_csv(source, expected_hash=None)


def test_classification_priority_sides_tags_and_same_target_tie(tmp_path):
    for name, rows in [
        ("csv-expense-classification-review-20260906.csv", [
            [2, "식비/외식", "왼쪽", "합성태그,두번째"],
            [3, "식비/외식", "왼쪽", ""], [3, "식비/외식", "오른쪽", ""],
            [4, "식비/외식", "왼쪽", ""],
        ]),
        ("csv-deposit-classification-review-20260906.csv", [
            [2, "자산/계약금·보증금/주거 보증금", "왼쪽", "합성태그"],
            [4, "식비/외식", "오른쪽", ""],
        ]),
    ]:
        with (tmp_path / name).open("w", encoding="utf-8", newline="") as stream:
            csv.writer(stream).writerows([["원본 행", "연결 계정", "연결 계정 위치", "태그"], *rows])
    result = importer.load_classifications(tmp_path)
    assert result[2].left == ("asset", ("계약금·보증금", "주거 보증금"))
    assert result[2].tags == {"합성태그", "두번째"}
    assert result[3].left == ("expense", ("식비", "외식")) and result[3].right is None
    assert result[4].left is None and result[4].right == ("expense", ("식비", "외식"))


@pytest.mark.parametrize("raw,expected", [
    ("문화·여가 → 여행", ("expense", ("문화·여가", "여행", "기타 여행"))),
    ("쇼핑·생활용품", ("expense", ("쇼핑·생활용품", "생활소모품"))),
    ("경조사·선물", ("expense", ("경조사·선물", "선물"))),
    ("부채 > 개인채무 > 합성채무", ("liability", ("개인채무", "합성채무"))),
    ("", None), ("unknown", None), ("자산", None), ("식비 ↔ 현금", None),
])
def test_classification_path_normalization(raw, expected):
    assert importer._normalize_path(raw) == expected


def test_mid_import_failure_rolls_back_accounts_postings_tags_and_provenance(tmp_path, monkeypatch):
    source, classifications = _write_fixture(tmp_path)
    conn = connect(":memory:")
    try:
        init_db(conn)
        before = list(conn.iterdump())
        replace = importer._replace_tags
        def fail_after_tags(c, tid, tags):
            replace(c, tid, tags)
            raise RuntimeError("synthetic import failure")
        monkeypatch.setattr(importer, "_replace_tags", fail_after_tags)
        with pytest.raises(RuntimeError, match="synthetic import failure"):
            importer.import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
        assert not conn.in_transaction
        assert list(conn.iterdump()) == before
    finally:
        conn.close()


def test_import_backup_is_restorable_and_does_not_modify_source(tmp_path):
    conn = connect(":memory:")
    try:
        init_db(conn)
        before = list(conn.iterdump())
        path = run_import_backup(conn, tmp_path / "backups", "a" * 64)
        assert path.is_file() and path.name.startswith("legacy-import-")
        assert not list(path.parent.glob("*.partial"))
        with sqlite3.connect(path) as restored:
            assert restored.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert list(restored.iterdump()) == before
        assert list(conn.iterdump()) == before
    finally:
        conn.close()


def test_backup_integrity_failure_never_publishes_recovery_candidate(tmp_path, monkeypatch):
    import moneymap.adapters.sqlite.backup as backup
    class BadBackup:
        closed = False
        def execute(self, sql):
            assert sql == "PRAGMA integrity_check"
            return [("synthetic corruption",)]
        def close(self):
            self.closed = True
    class Source:
        def backup(self, destination):
            assert destination is bad
    bad = BadBackup()
    monkeypatch.setattr(backup.sqlite3, "connect", lambda path: bad)
    with pytest.raises(sqlite3.DatabaseError, match="integrity check failed"):
        run_import_backup(Source(), tmp_path / "backups", "a" * 64)
    assert bad.closed
    assert not list((tmp_path / "backups").glob("*.db"))
