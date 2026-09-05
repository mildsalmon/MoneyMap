"""Each request owns its connection; reads share one explicit SQLite snapshot."""

from fastapi import Request

from moneymap.adapters.sqlite import (
    SqliteAccountRepository,
    SqliteLedgerQueries,
    SqliteRecurringRuleRepository,
    SqliteScenarioRepository,
    SqliteTransactionRepository,
    connect,
)


def request_connection(request: Request):
    conn = connect(request.app.state.db_path)
    request.state.conn = conn
    try:
        if request.method in {"GET", "HEAD"}:
            conn.execute("BEGIN")
        yield conn
    finally:
        conn.rollback()
        conn.close()


def repos(request: Request):
    conn = request.state.conn
    return {
        "conn": conn,
        "accounts": SqliteAccountRepository(conn),
        "txns": SqliteTransactionRepository(conn),
        "scenarios": SqliteScenarioRepository(conn),
        "rules": SqliteRecurringRuleRepository(conn),
        "queries": SqliteLedgerQueries(conn),
    }
