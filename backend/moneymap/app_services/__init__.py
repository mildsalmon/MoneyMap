"""애플리케이션 서비스 — 유스케이스 조립 레이어.

도메인(순수)과 포트만 의존한다. FastAPI(인바운드)와 SQLite(아웃바운드)
사이에서 시나리오 fork, 순자산 곡선 조립 같은 흐름을 담당한다.
"""

from __future__ import annotations

import datetime

from moneymap.domain.account import (
    AccountSettingsCommand,
    AccountSettingsResult,
)
from moneymap.domain.ports import (
    AccountRepository,
    TransactionRepository,
)
from moneymap.domain.transaction import Transaction


def update_account_settings(
    command: AccountSettingsCommand,
    account_repo: AccountRepository,
) -> AccountSettingsResult:
    """원자적 전체 상태 설정 명령을 어댑터 포트에 위임한다."""
    return account_repo.update_settings(command)


def create_opening_balance(
    account_id: int,
    date: datetime.date,
    amount: int,
    state: str,
    txn_repo: TransactionRepository,
) -> Transaction:
    """서버가 부호와 상대 계정을 소유하는 개시잔액 명령."""
    return txn_repo.create_opening_balance(account_id, date, amount, state)
