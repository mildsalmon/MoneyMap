"""Transaction owner for scenario aggregates, including copy-on-fork in PR1."""

from moneymap.adapters.sqlite.common import _account_write
from moneymap.adapters.sqlite.rules import ScenarioRuleWriter
from moneymap.adapters.sqlite.scenarios import ScenarioWriter
from moneymap.adapters.sqlite.transactions import ScenarioTransactionWriter


class SqliteUnitOfWork:
    def __init__(self, conn):
        self.conn = conn
        from .accounts import SqliteAccountRepository

        self.accounts = SqliteAccountRepository(conn)
        self.scenarios = ScenarioWriter(conn)
        self.rules = ScenarioRuleWriter(conn)
        self.transactions = ScenarioTransactionWriter(conn)

    def __enter__(self):
        self._boundary = _account_write(self.conn)
        self._boundary.__enter__()
        return self

    def __exit__(self, *exc):
        return self._boundary.__exit__(*exc)
