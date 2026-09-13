"""Lossless one-row-to-one-transaction importer for the reviewed legacy CSV."""

from __future__ import annotations

import csv
import datetime
import hashlib
import json
import unicodedata
from dataclasses import dataclass, field, replace
from pathlib import Path

from moneymap.adapters.sqlite.database import _next_sibling_position
from moneymap.adapters.sqlite.transactions import _replace_tags
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID
from moneymap.domain.transaction_input import normalize_item_key


EXPECTED_SOURCE_HASH = "b2849c42fd1b20f7ab65cb0f2189dbe859028a16f78e8d081ad8f1d415ec9814"
TYPE_MAP = {"자산": "asset", "부채": "liability", "수익": "income", "비용": "expense", "순자산": "equity"}
TYPE_PREFIX = {"자산": "asset", "부채": "liability", "수익": "income", "비용": "expense", "순자산": "equity"}
EXPENSE_ROOTS = {
    "식비", "교통", "문화·여가", "카페·간식", "주거·관리비", "통신",
    "쇼핑·생활용품", "의류", "미용·관리", "의료·건강", "보험",
    "경조사·선물", "교육·자기계발", "디지털 도구", "금융비용",
    "세금", "투자손익", "기타지출",
}
ASSET_ROOTS = {"외화", "계약금·보증금"}
EQUITY_ROOTS = {"투자 평가손익", "기초잔액(과거 이관)"}
LOCAL_CORRECTIONS = Path(__file__).resolve().parents[1] / "local" / "legacy-row-corrections.json"
VALUATION_LOSS_ROWS = {3490, 3697}
VALUATION_GAIN_ROWS = {3278}
REALIZED_LOSS_ROWS = {6606}


@dataclass(frozen=True)
class LegacyRow:
    source_row: int
    date: datetime.date
    description: str
    amount: int
    running_total: int
    left_type: str
    left_account: str
    right_type: str
    right_account: str
    memo: str
    raw_memo: str


@dataclass
class RowClassification:
    left: tuple[str, tuple[str, ...]] | None = None
    right: tuple[str, tuple[str, ...]] | None = None
    left_priority: int = -1
    right_priority: int = -1
    tags: set[str] = field(default_factory=set)


def _clean(value: str | None) -> str:
    return unicodedata.normalize("NFC", value or "").strip()


def source_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def parse_legacy_csv(path: Path, *, expected_hash: str | None = EXPECTED_SOURCE_HASH,
                     corrections_path: Path | None = None) -> tuple[list[LegacyRow], list[int]]:
    digest = source_hash(path)
    if expected_hash is not None and digest != expected_hash:
        raise ValueError(f"원본 CSV SHA-256 불일치: {digest}")
    # Private memo corrections belong to this exact source, never to every CSV's row number.
    local_path = corrections_path if corrections_path is not None else LOCAL_CORRECTIONS
    corrections = json.loads(local_path.read_text(encoding="utf-8")).get(digest, {}) if local_path.exists() else {}
    if not isinstance(corrections, dict) or any(
        not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(s, str) and s for s in pair)
        for pair in corrections.values()
    ):
        raise ValueError("로컬 메모 교정 형식 오류")
    parsed: list[LegacyRow] = []
    orphan_rows: list[int] = []
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        records = csv.reader(stream)
        header = next(records, None)
        if header is None or len(header) != 9:
            raise ValueError("CSV 헤더는 9개 열이어야 합니다")
        for source_row, record in enumerate(records, 2):
            if record and _clean(record[0]) == "멘토링" and all(not _clean(value) for value in record[1:]):
                if not parsed:
                    raise ValueError(f"연결할 수 없는 메모 행: {source_row}")
                previous = parsed[-1]
                parsed[-1] = replace(previous, memo="\n".join(filter(None, [previous.memo, "멘토링"])))
                orphan_rows.append(source_row)
                continue
            if len(record) != 9:
                raise ValueError(f"{source_row}행의 열 수가 9가 아닙니다: {len(record)}")
            raw_date, description, raw_amount, raw_total, left_type, left_account, right_type, right_account, raw_memo = record
            try:
                date = datetime.date.fromisoformat(raw_date)
                amount = int(raw_amount.replace(",", ""))
                running_total = int(raw_total.replace(",", ""))
            except ValueError as exc:
                raise ValueError(f"{source_row}행 날짜 또는 금액 형식 오류") from exc
            if amount < 0:
                raise ValueError(f"{source_row}행 금액은 음수일 수 없습니다")
            if left_type not in TYPE_MAP or right_type not in TYPE_MAP:
                raise ValueError(f"{source_row}행 계정 유형 오류")
            memo = raw_memo or ""
            correction = corrections.get(str(source_row))
            if correction:
                memo = memo.replace(*correction)
            parsed.append(LegacyRow(
                source_row=source_row,
                date=date,
                description=description,
                amount=amount,
                running_total=running_total,
                left_type=left_type,
                left_account=left_account,
                right_type=right_type,
                right_account=right_account,
                memo=memo,
                raw_memo=raw_memo or "",
            ))
    return parsed, orphan_rows


def _normalize_path(raw: str) -> tuple[str, tuple[str, ...]] | None:
    value = _clean(raw).replace(" → ", "/").replace(" > ", "/")
    if not value or "↔" in value or "←" in value:
        return None
    parts = tuple(part.strip() for part in value.split("/") if part.strip())
    if not parts:
        return None
    explicit_type = TYPE_PREFIX.get(parts[0])
    if explicit_type:
        parts = parts[1:]
    if not parts:
        return None
    if parts == ("문화·여가", "여행"):
        parts = (*parts, "기타 여행")
    elif parts == ("쇼핑·생활용품",):
        parts = (*parts, "생활소모품")
    elif parts == ("경조사·선물",):
        parts = (*parts, "선물")
    if explicit_type:
        account_type = explicit_type
    elif parts[0] in EXPENSE_ROOTS:
        account_type = "expense"
    elif parts[0] in ASSET_ROOTS:
        account_type = "asset"
    elif parts[0] in EQUITY_ROOTS:
        account_type = "equity"
    else:
        return None
    return account_type, parts


def _headers(table: csv.DictReader) -> tuple[str | None, str | None, str | None, str | None]:
    fields = table.fieldnames or []
    row_key = next((key for key in ("원본 행", "원본CSV행번호") if key in fields), None)
    path_key = next((key for key in ("연결 계정", "연결계정", "연결 계정 또는 분개", "제안계정") if key in fields), None)
    side_key = next((key for key in ("연결 계정 위치", "연결위치", "비용 계정 위치") if key in fields), None)
    tag_key = "태그" if "태그" in fields else None
    return row_key, path_key, side_key, tag_key


def load_classifications(directory: Path) -> dict[int, RowClassification]:
    result: dict[int, RowClassification] = {}
    files = sorted(directory.glob("csv-*-classification-review-2026090*.csv"))
    candidate = directory / "csv-food-reclassification-candidates-20260905.csv"
    if candidate.exists():
        files.append(candidate)
    if not files:
        raise ValueError(f"분류 자료를 찾을 수 없습니다: {directory}")
    for path in files:
        priority = 100 if "deposit-classification" in path.name else 50
        if "food-reclassification-candidates" in path.name:
            priority = 60
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            table = csv.DictReader(stream)
            row_key, path_key, side_key, tag_key = _headers(table)
            if row_key is None or path_key is None:
                continue
            for source in table:
                try:
                    source_row = int(source.get(row_key) or 0)
                except ValueError:
                    continue
                target = _normalize_path(source.get(path_key) or "")
                if source_row <= 1 or target is None:
                    continue
                side = _clean(source.get(side_key)) if side_key else "왼쪽"
                classification = result.setdefault(source_row, RowClassification())
                if side == "오른쪽":
                    if priority >= classification.right_priority:
                        classification.right = target
                        classification.right_priority = priority
                elif priority >= classification.left_priority:
                    classification.left = target
                    classification.left_priority = priority
                if tag_key:
                    raw_tags = source.get(tag_key) or ""
                    classification.tags.update(
                        tag.strip() for tag in raw_tags.replace(",", "|").split("|") if tag.strip()
                    )
    for row in VALUATION_LOSS_ROWS:
        item = result.setdefault(row, RowClassification())
        item.left = ("equity", ("투자 평가손익",))
        item.left_priority = 200
    for row in VALUATION_GAIN_ROWS:
        item = result.setdefault(row, RowClassification())
        item.right = ("equity", ("투자 평가손익",))
        item.right_priority = 200
    for row in REALIZED_LOSS_ROWS:
        item = result.setdefault(row, RowClassification())
        item.left = ("expense", ("투자손익", "실현손익"))
        item.left_priority = 200
    for item in result.values():
        if item.left is not None and item.left == item.right:
            if item.right_priority > item.left_priority:
                item.left = None
                item.left_priority = -1
            else:
                item.right = None
                item.right_priority = -1
    return result


def _find_path(conn, account_type: str, path: tuple[str, ...]) -> int | None:
    parent_id = None
    found = None
    for name in path:
        row = conn.execute(
            "SELECT id FROM accounts WHERE type=? AND name=? AND parent_id IS ? ORDER BY id LIMIT 1",
            (account_type, name, parent_id),
        ).fetchone()
        if row is None:
            return None
        found = row["id"]
        parent_id = found
    return found


def _ensure_path(conn, account_type: str, path: tuple[str, ...]) -> tuple[int, int]:
    parent_id = None
    created = 0
    for index, name in enumerate(path):
        row = conn.execute(
            "SELECT id,is_placeholder FROM accounts WHERE type=? AND name=? AND parent_id IS ? ORDER BY id LIMIT 1",
            (account_type, name, parent_id),
        ).fetchone()
        intermediate = index < len(path) - 1
        if row is None:
            position = _next_sibling_position(conn, account_type, parent_id)
            cursor = conn.execute(
                "INSERT INTO accounts(name,type,parent_id,is_placeholder,position,version) VALUES(?,?,?,?,?,1)",
                (name, account_type, parent_id, int(intermediate), position),
            )
            parent_id = cursor.lastrowid
            created += 1
        else:
            parent_id = row["id"]
            if intermediate and not row["is_placeholder"]:
                if conn.execute("SELECT 1 FROM postings WHERE account_id=? LIMIT 1", (parent_id,)).fetchone():
                    raise ValueError(f"거래가 있는 계정을 그룹으로 바꿀 수 없습니다: {'/'.join(path[:index + 1])}")
                conn.execute("UPDATE accounts SET is_placeholder=1,version=version+1 WHERE id=?", (parent_id,))
    assert parent_id is not None
    return int(parent_id), created


def _legacy_path(conn, korean_type: str, name: str) -> tuple[str, tuple[str, ...]]:
    account_type = TYPE_MAP[korean_type]
    if korean_type == "자산":
        if name.casefold() == "ok저축은행".casefold():
            return account_type, ("입출금통장", "OK저축은행")
        if name in {"아파트", "한마을아파트"}:
            return account_type, ("한마을아파트",)
    if korean_type == "부채" and name == "갚을돈":
        return account_type, ("개인채무", "갚을돈")
    exact = conn.execute(
        "SELECT id FROM accounts WHERE type=? AND name=? AND is_placeholder=0 ORDER BY id LIMIT 1",
        (account_type, name),
    ).fetchone()
    if exact:
        return account_type, (f"@id:{exact['id']}",)
    if korean_type == "자산":
        if any(token in name for token in ("증권", "업비트", "빗썸")):
            return account_type, ("투자", name)
        if any(token in name for token in ("적금", "저축", "예금", "청년도약", "IRP", "연금저축", "ISA")):
            return account_type, ("저축·적금", name)
        if name in {"강릉", "광명", "김천", "나주", "동해", "부산(동백전)", "서울페이", "제주(탐나는전)", "카카오포인트", "네이버페이", "온누리상품권", "하이플러스"}:
            return account_type, ("페이·선불충전", name)
        if name in {"받을돈", "보증금"}:
            return account_type, (name,)
        if name != "현금":
            return account_type, ("입출금통장", name)
    if korean_type == "부채":
        if "카드" in name:
            return account_type, ("신용카드", name)
        if "대출" in name or "담보" in name:
            return account_type, ("대출", name)
    if korean_type == "수익":
        aliases = {"월급": "급여", "배당/이자": "이자·배당"}
        return account_type, (aliases.get(name, name),)
    if korean_type == "순자산":
        return account_type, (("기초잔액(과거 이관)" if name == "기초잔액" else name),)
    if korean_type == "비용":
        if name == "원화에서달러로환전":
            return account_type, (name,)
        return account_type, ("기타지출",)
    return account_type, (name,)


def _resolve_target(conn, target: tuple[str, tuple[str, ...]]) -> tuple[int, int]:
    account_type, path = target
    if len(path) == 1 and path[0].startswith("@id:"):
        return int(path[0][4:]), 0
    return _ensure_path(conn, account_type, path)


def _default_tags(row: LegacyRow) -> set[str]:
    tags: set[str] = set()
    for account in (row.left_account, row.right_account):
        if account.startswith("데이트("):
            tags.add("데이트")
        elif account.startswith("엄마("):
            tags.add("엄마")
        elif account.startswith("지인("):
            tags.add("지인")
    return tags


def import_legacy_csv(conn, source: Path, classifications_dir: Path, *, apply: bool, expected_hash: str | None = EXPECTED_SOURCE_HASH) -> dict:
    rows, orphan_rows = parse_legacy_csv(source, expected_hash=expected_hash)
    classifications = load_classifications(classifications_dir)
    digest = source_hash(source)
    inserted = skipped = accounts_created = 0
    imported_amount = 0
    conn.execute("BEGIN IMMEDIATE")
    try:
        existing_postings = conn.execute(
            "SELECT COUNT(*) FROM postings p JOIN transaction_import_provenance i ON i.txn_id=p.txn_id WHERE i.source_hash=?",
            (digest,),
        ).fetchone()[0]
        for row in rows:
            duplicate = conn.execute(
                "SELECT txn_id FROM transaction_import_provenance WHERE source_hash=? AND source_row=?",
                (digest, row.source_row),
            ).fetchone()
            if duplicate:
                skipped += 1
                continue
            classification = classifications.get(row.source_row, RowClassification())
            left_target = classification.left or _legacy_path(conn, row.left_type, row.left_account)
            right_target = classification.right or _legacy_path(conn, row.right_type, row.right_account)
            left_id, made = _resolve_target(conn, left_target)
            accounts_created += made
            right_id, made = _resolve_target(conn, right_target)
            accounts_created += made
            if left_id == right_id:
                raise ValueError(f"{row.source_row}행의 양쪽 계정이 같습니다")
            cursor = conn.execute(
                "INSERT INTO transactions(scenario_id,date,description,source_rule_id,item_key,entry_origin,memo,posted) "
                "VALUES(?,?,?,?,?,?,?,0)",
                (ACTUAL_SCENARIO_ID, row.date.isoformat(), row.description, None,
                 normalize_item_key(row.description), "legacy_unknown", row.memo),
            )
            txn_id = cursor.lastrowid
            conn.executemany(
                "INSERT INTO postings(txn_id,account_id,amount,currency) VALUES(?,?,?,'KRW')",
                [(txn_id, left_id, row.amount), (txn_id, right_id, -row.amount)],
            )
            conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (txn_id,))
            tags = _default_tags(row) | classification.tags
            _replace_tags(conn, txn_id, sorted(tags))
            conn.execute(
                "INSERT INTO transaction_import_provenance("
                "txn_id,source_hash,source_file,source_row,raw_date,raw_description,raw_amount,raw_running_total,"
                "raw_left_type,raw_left_account,raw_right_type,raw_right_account,raw_memo) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (txn_id, digest, source.name, row.source_row, row.date.isoformat(), row.description,
                 str(row.amount), str(row.running_total), row.left_type, row.left_account,
                 row.right_type, row.right_account, row.raw_memo),
            )
            inserted += 1
            imported_amount += row.amount
        total_provenance = conn.execute(
            "SELECT COUNT(*) FROM transaction_import_provenance WHERE source_hash=?", (digest,)
        ).fetchone()[0]
        posting_count = conn.execute(
            "SELECT COUNT(*) FROM postings p JOIN transaction_import_provenance i ON i.txn_id=p.txn_id WHERE i.source_hash=?",
            (digest,),
        ).fetchone()[0]
        imbalance = conn.execute(
            "SELECT COUNT(*) FROM (SELECT p.txn_id FROM postings p JOIN transaction_import_provenance i ON i.txn_id=p.txn_id "
            "WHERE i.source_hash=? GROUP BY p.txn_id HAVING SUM(p.amount) != 0)",
            (digest,),
        ).fetchone()[0]
        # Existing imported transactions may have been edited into balanced splits.
        # Only this run's inserts must add exactly two postings per source row.
        if total_provenance != len(rows) or posting_count != existing_postings + inserted * 2 or imbalance:
            raise ValueError("이관 사후 검산 실패")
        report = {
            "source_hash": digest,
            "parsed_transactions": len(rows),
            "orphan_memo_rows": orphan_rows,
            "inserted": inserted,
            "skipped_existing": skipped,
            "accounts_created": accounts_created,
            "provenance_rows": total_provenance,
            "postings": posting_count,
            "imbalanced": imbalance,
            "source_amount_sum": sum(row.amount for row in rows),
            "inserted_amount_sum": imported_amount,
            "zero_amount_transactions": sum(row.amount == 0 for row in rows),
            "mode": "apply" if apply else "dry-run",
        }
        if apply:
            conn.commit()
        else:
            conn.rollback()
        return report
    except BaseException:
        conn.rollback()
        raise
