"""포트 — 도메인이 바깥세상에 요구하는 인터페이스 (헥사고날, D15).

어댑터(SQLite 등)가 이 Protocol들을 구현한다. 도메인 서비스는
여기 정의된 포트만 알고, SQL이나 파일시스템은 모른다.
"""

from __future__ import annotations

import datetime
from typing import Protocol

from moneymap.domain.account import Account
from moneymap.domain.money import Money
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.scenario import Scenario
from moneymap.domain.transaction import Transaction


class AccountRepository(Protocol):
    def save(self, account: Account) -> Account: ...
    def find_by_id(self, account_id: int) -> Account | None: ...
    def find_all(self) -> list[Account]: ...


class TransactionRepository(Protocol):
    def save(self, txn: Transaction) -> Transaction: ...
    def find_by_scenario(
        self,
        scenario_id: int,
        start: datetime.date | None = None,
        end: datetime.date | None = None,
    ) -> list[Transaction]: ...


class ScenarioRepository(Protocol):
    def save(self, scenario: Scenario) -> Scenario: ...
    def find_by_id(self, scenario_id: int) -> Scenario | None: ...
    def list_all(self) -> list[Scenario]: ...


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
