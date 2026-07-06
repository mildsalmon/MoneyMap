"""리포지토리가 필요한 도메인 검증 — 엔티티 단독으로는 못 지키는 invariant.

- 부모 타입 일치: parent는 같은 type의 다른 계정 (설계서 원본 invariant)
- 순환 방지 (D8): 부모 체인을 따라가며 자기 자신이 나오면 거부
"""

from __future__ import annotations

from moneymap.domain.account import Account
from moneymap.domain.errors import AccountCycleError, DomainError
from moneymap.domain.ports import AccountRepository


def validate_account_placement(account: Account, repo: AccountRepository) -> None:
    """계정 저장 전 부모 관련 invariant를 검사한다. 위반 시 DomainError."""
    if account.parent_id is None:
        return
    if account.id is not None and account.parent_id == account.id:
        raise AccountCycleError("계정은 자기 자신을 부모로 가질 수 없습니다")

    parent = repo.find_by_id(account.parent_id)
    if parent is None:
        raise DomainError(f"부모 계정이 존재하지 않습니다: id={account.parent_id}")
    if parent.type != account.type:
        raise DomainError(
            f"부모 계정의 타입이 다릅니다: {parent.type} != {account.type}"
        )

    # 순환 검사: account를 저장하면 생길 부모 체인을 위로 따라간다.
    # 체인 어디서든 자기 자신(account.id)이 나오면 순환.
    seen: set[int] = set()
    current: Account | None = parent
    while current is not None:
        if current.id is None:
            break
        if account.id is not None and current.id == account.id:
            raise AccountCycleError(
                f"순환하는 부모 지정입니다: {account.name} → ... → {current.name}"
            )
        if current.id in seen:  # 기존 데이터가 이미 오염된 경우도 무한 루프 방지
            raise AccountCycleError("계정 트리에 이미 순환이 존재합니다")
        seen.add(current.id)
        current = (
            repo.find_by_id(current.parent_id) if current.parent_id is not None else None
        )
