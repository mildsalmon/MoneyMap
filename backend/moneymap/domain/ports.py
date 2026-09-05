"""포트 — 도메인이 바깥세상에 요구하는 인터페이스 (헥사고날, D15).

어댑터(SQLite 등)가 이 Protocol들을 구현한다. 도메인 서비스는
여기 정의된 포트만 알고, SQL이나 파일시스템은 모른다.
"""

from __future__ import annotations

import datetime
from typing import Protocol

from moneymap.domain.transaction_input import PairCandidate, RecentInput

from moneymap.domain.account import (
    Account,
    AccountSettingsCommand,
    AccountSettingsResult,
)
from moneymap.domain.money import Money
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.scenario import Scenario
from moneymap.domain.standard_accounts import StandardAccount
from moneymap.domain.transaction import Transaction


class AccountRepository(Protocol):
    def create(self, account: Account) -> Account: ...
    def update_settings(
        self, command: AccountSettingsCommand
    ) -> AccountSettingsResult: ...
    def set_archived(self, account_id: int, archived: bool) -> Account: ...
    def set_placeholder(self, account_id: int, is_placeholder: bool) -> Account: ...
    def seed_standard(self, items: tuple[StandardAccount, ...]) -> tuple[int, int]: ...
    def find_by_id(self, account_id: int) -> Account | None: ...
    def find_all(self) -> list[Account]: ...
    def has_children(self, account_id: int) -> bool: ...


class TransactionRepository(Protocol):
    def save(self, txn: Transaction) -> Transaction: ...
    def find_by_scenario(
        self,
        scenario_id: int,
        start: datetime.date | None = None,
        end: datetime.date | None = None,
    ) -> list[Transaction]: ...
    def create_opening_balance(
        self,
        account_id: int,
        date: datetime.date,
        amount: int,
        state: str,
    ) -> Transaction: ...
    def find_opening_balances(self, account_id: int | None = None) -> list[dict]: ...


class ScenarioRepository(Protocol):
    def save(self, scenario: Scenario) -> Scenario: ...
    def find_by_id(self, scenario_id: int) -> Scenario | None: ...
    def list_all(self, status: str | None = None) -> list[Scenario]: ...


class RecurringRuleRepository(Protocol):
    def save(self, rule: RecurringRule) -> RecurringRule: ...
    def find_by_scenario(self, scenario_id: int) -> list[RecurringRule]: ...


class LedgerQueries(Protocol):
    """CQRS 읽기 전용 집계."""

    def balance_at(
        self, account_id: int, at: datetime.date, scenario_id: int
    ) -> Money: ...


class Clock(Protocol):
    def today(self) -> datetime.date: ...


class ScenarioTransactionWriter(Protocol):
    def save(self, txn: Transaction) -> Transaction: ...
    def list_owned(self, sid: int) -> list[Transaction]: ...
    def replace(self, txn: Transaction) -> Transaction: ...


class ScenarioAggregateWriter(ScenarioRepository, Protocol):
    def impact(self, scenario: Scenario) -> dict: ...
    def transaction_summaries(self, sid: int) -> list[dict]: ...
    def remove_transactions(self, sid: int, ids: list[int] | None = None) -> None: ...
    def move_transaction(self, sid: int, tid: int, date: datetime.date) -> None: ...
    def delete(self, sid: int) -> None: ...


class ScenarioRuleWriter(RecurringRuleRepository, Protocol):
    def delete_owned(self, rule_id: int, sid: int) -> None: ...


class ScenarioUnitOfWork(Protocol):
    """Application service owns one atomic scenario/children write."""

    accounts: AccountRepository
    scenarios: ScenarioAggregateWriter
    rules: ScenarioRuleWriter
    transactions: ScenarioTransactionWriter

    def __enter__(self) -> "ScenarioUnitOfWork": ...
    def __exit__(self, exc_type, exc, traceback) -> bool | None: ...


class TransactionInputQueries(Protocol):
    def last_candidate(self, item_key: str) -> "PairCandidate | None": ...
    def recent(self, limit: int) -> "list[RecentInput]": ...
