"""도메인 포트의 SQLite 구현체 (아웃바운드 어댑터).

도메인 엔티티가 1차 invariant 검증을 이미 마친 상태로 들어오고,
스키마 트리거가 백스톱으로 같은 invariant를 지킨다 (이중 enforce).
"""

from __future__ import annotations

import sqlite3

from moneymap.adapters.sqlite.database import _next_sibling_position
from moneymap.domain.account import (
    Account,
    AccountSettingsCommand,
    AccountSettingsEffects,
    AccountSettingsResult,
    AccountType,
)
from moneymap.domain.errors import (
    DomainConflictError,
    DomainInvariantError,
    DomainNotFoundError,
    DomainValidationError,
)
from moneymap.domain.services import (
    validate_account_create,
    validate_account_settings_transition,
    validate_postable_accounts,
)
from moneymap.domain.standard_accounts import StandardAccount

from .common import _account_write


class SqliteAccountRepository:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def create(self, account: Account) -> Account:
        with _account_write(self._conn):
            desired = validate_account_create(account, self.find_all())
            if desired.parent_id is not None:
                self.assert_rule_free_before_grouping(desired.parent_id)
            position = _next_sibling_position(
                self._conn,
                desired.type.value,
                desired.parent_id,
            )
            cur = self._conn.execute(
                "INSERT INTO accounts "
                "(name, type, parent_id, currency, archived, is_placeholder, is_system, is_overdraft, include_in_cash, position, version) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,1)",
                (
                    desired.name,
                    desired.type.value,
                    desired.parent_id,
                    desired.currency,
                    int(desired.archived),
                    int(desired.is_placeholder),
                    int(desired.is_system),
                    int(desired.is_overdraft),
                    int(desired.include_in_cash),
                    position,
                ),
            )
            return desired.model_copy(
                update={"id": cur.lastrowid, "position": position, "version": 1}
            )

    def update_settings(
        self,
        command: AccountSettingsCommand,
    ) -> AccountSettingsResult:
        with _account_write(self._conn):
            current = self.find_by_id(command.account_id)
            if current is None:
                raise DomainNotFoundError(
                    "계정이 없습니다",
                    code="account_not_found",
                )
            if command.version != current.version:
                raise DomainConflictError(
                    "다른 화면에서 계정이 변경되었습니다. 최신 상태를 다시 불러오세요",
                    code="account_settings_stale",
                    context={"current_version": current.version},
                )

            accounts = self.find_all()
            desired = validate_account_settings_transition(current, command, accounts)
            moved = desired.parent_id != current.parent_id
            position = current.position
            if moved:
                position = _next_sibling_position(
                    self._conn,
                    desired.type.value,
                    desired.parent_id,
                )
            next_version = current.version + 1
            updated = self._conn.execute(
                "UPDATE accounts SET name=?, parent_id=?, is_overdraft=?, include_in_cash=?, position=?, "
                "version=? WHERE id=? AND version=?",
                (
                    desired.name,
                    desired.parent_id,
                    int(desired.is_overdraft),
                    int(desired.include_in_cash),
                    position,
                    next_version,
                    current.id,
                    current.version,
                ),
            )
            if updated.rowcount != 1:
                raise DomainConflictError(
                    "다른 화면에서 계정이 변경되었습니다. 최신 상태를 다시 불러오세요",
                    code="account_settings_stale",
                )

            source_parent_grouped = False
            if moved and current.parent_id is not None:
                previous_parent = self.find_by_id(current.parent_id)
                if (
                    previous_parent is not None
                    and not previous_parent.is_system
                    and not previous_parent.is_overdraft
                ):
                    grouped = self._conn.execute(
                        "UPDATE accounts SET is_placeholder=1, version=version+1 "
                        "WHERE id=? AND is_placeholder=0 "
                        "AND NOT EXISTS (SELECT 1 FROM accounts WHERE parent_id=?)",
                        (previous_parent.id, previous_parent.id),
                    )
                    source_parent_grouped = grouped.rowcount == 1

            saved = self.find_by_id(command.account_id)
            assert saved is not None
            return AccountSettingsResult(
                account=saved,
                effects=AccountSettingsEffects(
                    moved=moved,
                    previous_parent_id=current.parent_id,
                    source_parent_grouped=source_parent_grouped,
                ),
            )

    def set_archived(self, account_id: int, archived: bool) -> Account:
        with _account_write(self._conn):
            current = self.find_by_id(account_id)
            if current is None:
                raise DomainNotFoundError("계정이 없습니다", code="account_not_found")
            if archived and current.include_in_cash:
                raise DomainConflictError(
                    "현금 부족 계산에서 제외한 뒤 보관하세요",
                    code="cash_account_selected",
                )
            if not archived and current.parent_id is not None:
                parent = self.find_by_id(current.parent_id)
                if parent and parent.include_in_cash:
                    raise DomainConflictError(
                        "현금 부족 계산에서 제외한 뒤 복원하세요",
                        code="cash_account_parent_forbidden",
                    )
            if archived:
                children = self.active_child_count(account_id)
                if children:
                    raise DomainValidationError(
                        f"하위 계정 {children}개를 먼저 보관하세요",
                        code="account_has_active_children",
                        context={"children": children},
                    )
                rules = self.rule_reference_count(account_id)
                if rules:
                    raise DomainValidationError(
                        f"이 계정을 참조하는 반복 규칙 {rules}개(시나리오 포함)를 먼저 삭제하세요",
                        code="account_referenced_by_rules",
                        context={"rules": rules},
                    )
            elif current.parent_id is not None:
                parent = self.find_by_id(current.parent_id)
                if parent is not None and parent.archived:
                    raise DomainValidationError(
                        f"상위 그룹 '{parent.name}'을 먼저 복원하세요",
                        code="account_parent_archived",
                    )
            self._conn.execute(
                "UPDATE accounts SET archived=?, version=version+1 WHERE id=?",
                (int(archived), account_id),
            )
            saved = self.find_by_id(account_id)
            assert saved is not None
            return saved

    def set_placeholder(self, account_id: int, is_placeholder: bool) -> Account:
        with _account_write(self._conn):
            current = self.find_by_id(account_id)
            if current is None:
                raise DomainNotFoundError("계정이 없습니다", code="account_not_found")
            if is_placeholder and current.include_in_cash:
                raise DomainConflictError(
                    "현금 부족 계산에서 제외한 뒤 그룹으로 변경하세요",
                    code="cash_account_must_be_leaf",
                )
            if is_placeholder:
                if current.is_overdraft:
                    raise DomainConflictError(
                        "마이너스통장 설정을 해제한 뒤 그룹으로 변경하세요",
                        code="overdraft_cannot_be_group",
                    )
                self.assert_rule_free_before_grouping(account_id)
                if self.has_postings(account_id):
                    raise DomainValidationError(
                        "이 계정에는 이미 거래가 있어 그룹으로 바꿀 수 없습니다 (거래를 옮긴 뒤 시도하세요)",
                        code="account_has_postings",
                    )
            self._conn.execute(
                "UPDATE accounts SET is_placeholder=?, version=version+1 WHERE id=?",
                (int(is_placeholder), account_id),
            )
            saved = self.find_by_id(account_id)
            assert saved is not None
            return saved

    def _find_id_by_path(
        self,
        path: tuple[str, ...],
        account_type: AccountType,
    ) -> int | None:
        parent_id: int | None = None
        found_id: int | None = None
        for name in path:
            row = self._conn.execute(
                "SELECT id FROM accounts WHERE name=? AND type=? AND parent_id IS ? "
                "ORDER BY id LIMIT 1",
                (name, account_type.value, parent_id),
            ).fetchone()
            if row is None:
                return None
            found_id = row["id"]
            parent_id = found_id
        return found_id

    def seed_standard(self, items: tuple[StandardAccount, ...]) -> tuple[int, int]:
        created = 0
        skipped = 0
        with _account_write(self._conn):
            roots = [item for item in items if len(item.path) == 1]
            children = sorted(
                [item for item in items if len(item.path) > 1],
                key=lambda item: len(item.path),
            )
            for item in [*roots, *children]:
                if self._find_id_by_path(item.path, item.type) is not None:
                    skipped += 1
                    continue
                parent_id = None
                if len(item.path) > 1:
                    parent_id = self._find_id_by_path(item.path[:-1], item.type)
                    if parent_id is None:
                        raise DomainInvariantError(
                            f"표준 계정 상위 경로가 없습니다: {'/'.join(item.path[:-1])}",
                            code="standard_account_parent_missing",
                        )
                position = _next_sibling_position(
                    self._conn,
                    item.type.value,
                    parent_id,
                )
                self._conn.execute(
                    "INSERT INTO accounts "
                    "(name, type, parent_id, is_placeholder, position, version) "
                    "VALUES (?,?,?,?,?,1)",
                    (
                        item.path[-1],
                        item.type.value,
                        parent_id,
                        int(item.is_group),
                        position,
                    ),
                )
                created += 1
        return created, skipped

    def has_children(self, account_id: int) -> bool:
        return (
            self._conn.execute(
                "SELECT 1 FROM accounts WHERE parent_id=? LIMIT 1", (account_id,)
            ).fetchone()
            is not None
        )

    def has_postings(self, account_id: int) -> bool:
        return (
            self._conn.execute(
                "SELECT 1 FROM postings WHERE account_id=? LIMIT 1", (account_id,)
            ).fetchone()
            is not None
        )

    @staticmethod
    def _row_to_account(row: sqlite3.Row) -> Account:
        return Account(
            id=row["id"],
            name=row["name"],
            type=AccountType(row["type"]),
            parent_id=row["parent_id"],
            currency=row["currency"],
            archived=bool(row["archived"]),
            is_placeholder=bool(row["is_placeholder"]),
            is_system=bool(row["is_system"]),
            is_overdraft=bool(row["is_overdraft"]),
            include_in_cash=bool(row["include_in_cash"]),
            position=row["position"],
            version=row["version"],
        )

    def find_by_id(self, account_id: int) -> Account | None:
        row = self._conn.execute(
            "SELECT * FROM accounts WHERE id=?", (account_id,)
        ).fetchone()
        return self._row_to_account(row) if row else None

    def find_by_name(self, name: str) -> Account | None:
        row = self._conn.execute(
            "SELECT * FROM accounts WHERE name=?", (name,)
        ).fetchone()
        return self._row_to_account(row) if row else None

    def find_all(self) -> list[Account]:
        rows = self._conn.execute(
            "SELECT * FROM accounts "
            "ORDER BY type, COALESCE(parent_id, -1), position, id"
        ).fetchall()
        return [self._row_to_account(r) for r in rows]

    def reclassify_direct(self, account_id: int, to: int) -> int:
        conn = self._conn
        with _account_write(conn):
            parent = self.find_by_id(account_id)
            child = self.find_by_id(to)
            if parent is None or child is None:
                raise DomainNotFoundError("계정이 없습니다", code="account_not_found")
            if child.parent_id != account_id:
                raise DomainValidationError(
                    "이동 대상은 이 계정의 직접 하위 계정이어야 합니다",
                    code="account_direct_child_required",
                )
            validate_postable_accounts(self.find_all(), [to])
            txn_ids = [
                row["txn_id"]
                for row in conn.execute(
                    "SELECT DISTINCT txn_id FROM postings WHERE account_id=?",
                    (account_id,),
                ).fetchall()
            ]
            if txn_ids:
                marks = ",".join("?" for _ in txn_ids)
                conn.execute(
                    f"UPDATE transactions SET posted=0 WHERE id IN ({marks})", txn_ids
                )
            cur = conn.execute(
                "UPDATE postings SET account_id=? WHERE account_id=?",
                (to, account_id),
            )
            if txn_ids:
                marks = ",".join("?" for _ in txn_ids)
                conn.execute(
                    f"UPDATE transactions SET posted=1 WHERE id IN ({marks})", txn_ids
                )
            return cur.rowcount

    def rule_reference_count(self, account_id: int) -> int:
        return self._conn.execute(
            "SELECT COUNT(*) FROM recurring_rules WHERE from_account_id=? OR to_account_id=?",
            (account_id, account_id),
        ).fetchone()[0]

    def active_child_count(self, account_id: int) -> int:
        return self._conn.execute(
            "SELECT COUNT(*) FROM accounts WHERE parent_id=? AND archived=0",
            (account_id,),
        ).fetchone()[0]

    def assert_rule_free_before_grouping(self, account_id: int) -> None:
        if self.rule_reference_count(account_id):
            raise DomainValidationError(
                "이 계정을 참조하는 반복 규칙을 먼저 다른 계정으로 바꾼 뒤 그룹으로 변경하세요",
                code="account_referenced_by_rules",
            )
