"""표준 계정과목 분류표.

path는 같은 이름이 다른 부모 아래에 있어도 구분되는 멱등 키다.
시드 엔드포인트는 이 데이터를 부모 -> 자식 순서로 생성한다.
"""

from __future__ import annotations

from dataclasses import dataclass

from moneymap.domain.account import AccountType


@dataclass(frozen=True)
class StandardAccount:
    path: tuple[str, ...]
    type: AccountType
    is_group: bool = False


STANDARD_ACCOUNTS: tuple[StandardAccount, ...] = (
    StandardAccount(("현금",), AccountType.ASSET),
    StandardAccount(("입출금통장",), AccountType.ASSET, is_group=True),
    StandardAccount(("저축·적금",), AccountType.ASSET, is_group=True),
    StandardAccount(("투자",), AccountType.ASSET, is_group=True),
    StandardAccount(("페이·선불충전",), AccountType.ASSET, is_group=True),
    StandardAccount(("신용카드",), AccountType.LIABILITY, is_group=True),
    StandardAccount(("대출",), AccountType.LIABILITY, is_group=True),
    StandardAccount(("급여",), AccountType.INCOME),
    StandardAccount(("이자·배당",), AccountType.INCOME),
    StandardAccount(("기타수익",), AccountType.INCOME),
    StandardAccount(("식비",), AccountType.EXPENSE, is_group=True),
    StandardAccount(("식비", "외식"), AccountType.EXPENSE),
    StandardAccount(("식비", "식료품"), AccountType.EXPENSE),
    StandardAccount(("식비", "배달"), AccountType.EXPENSE),
    StandardAccount(("교통",), AccountType.EXPENSE, is_group=True),
    StandardAccount(("교통", "대중교통"), AccountType.EXPENSE),
    StandardAccount(("교통", "택시"), AccountType.EXPENSE),
    StandardAccount(("교통", "자가용"), AccountType.EXPENSE),
    StandardAccount(("문화·여가",), AccountType.EXPENSE, is_group=True),
    StandardAccount(("문화·여가", "구독"), AccountType.EXPENSE),
    StandardAccount(("문화·여가", "여행"), AccountType.EXPENSE),
    StandardAccount(("문화·여가", "취미·오락"), AccountType.EXPENSE),
    StandardAccount(("카페·간식",), AccountType.EXPENSE),
    StandardAccount(("주거·관리비",), AccountType.EXPENSE),
    StandardAccount(("통신",), AccountType.EXPENSE),
    StandardAccount(("쇼핑·생활용품",), AccountType.EXPENSE),
    StandardAccount(("의료·건강",), AccountType.EXPENSE),
    StandardAccount(("보험",), AccountType.EXPENSE),
    StandardAccount(("경조사·선물",), AccountType.EXPENSE),
    StandardAccount(("기타지출",), AccountType.EXPENSE),
    StandardAccount(("개시잔액",), AccountType.EQUITY),
)
