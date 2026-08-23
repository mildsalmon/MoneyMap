"""MoneyMap 도메인 레이어.

헥사고날 아키텍처의 중심. 이 패키지는 표준 라이브러리와 Pydantic에만
의존한다 — FastAPI/SQLite 등 어댑터 계층의 import는 금지.
"""

from moneymap.domain.account import (
    Account,
    AccountSettingsCommand,
    AccountSettingsEffects,
    AccountSettingsResult,
    AccountType,
    reporting_type,
)
from moneymap.domain.errors import (
    DomainConflictError,
    DomainError,
    DomainInvariantError,
    DomainNotFoundError,
    DomainUnavailableError,
    DomainValidationError,
    InvalidScheduleError,
    InvalidScenarioBaseError,
    MixedCurrencyError,
    UnbalancedTransactionError,
)
from moneymap.domain.money import Money
from moneymap.domain.recurring_rule import RecurringRule
from moneymap.domain.scenario import ACTUAL_SCENARIO_ID, Scenario
from moneymap.domain.schedule import Schedule
from moneymap.domain.transaction import Posting, Transaction

__all__ = [
    "ACTUAL_SCENARIO_ID",
    "Account",
    "AccountSettingsCommand",
    "AccountSettingsEffects",
    "AccountSettingsResult",
    "AccountType",
    "DomainConflictError",
    "DomainError",
    "DomainInvariantError",
    "DomainNotFoundError",
    "DomainUnavailableError",
    "DomainValidationError",
    "InvalidScenarioBaseError",
    "InvalidScheduleError",
    "MixedCurrencyError",
    "Money",
    "Posting",
    "RecurringRule",
    "Scenario",
    "Schedule",
    "Transaction",
    "UnbalancedTransactionError",
    "reporting_type",
]
