"""Compatibility exports; implementations live in feature modules."""

from .accounts import SqliteAccountRepository
from .common import SystemClock
from .materialization import apply_materialization
from .reporting import SqliteLedgerQueries
from .rules import SqliteRecurringRuleRepository
from .scenarios import SqliteScenarioRepository
from .transactions import SqliteTransactionRepository

__all__ = [
    "SqliteAccountRepository",
    "SqliteLedgerQueries",
    "SqliteRecurringRuleRepository",
    "SqliteScenarioRepository",
    "SqliteTransactionRepository",
    "SystemClock",
    "apply_materialization",
]
