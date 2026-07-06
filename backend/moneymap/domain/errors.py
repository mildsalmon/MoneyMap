"""도메인 invariant 위반 시 발생하는 예외들.

어댑터(FastAPI)는 이 예외들을 잡아 사용자에게 "어느 필드가 어느
invariant를 어겼는지" 인라인 에러로 보여준다 (UI 스펙 D9).
"""


class DomainError(Exception):
    """모든 도메인 오류의 베이스."""


class UnbalancedTransactionError(DomainError):
    """차변=대변 invariant 위반: postings 합이 0이 아님."""


class MixedCurrencyError(DomainError):
    """단일 통화 invariant 위반: 한 거래 안에 서로 다른 currency."""


class AccountCycleError(DomainError):
    """계정 트리 순환: 부모 체인을 따라가면 자기 자신이 나옴."""


class InvalidScenarioBaseError(DomainError):
    """v1 depth-1 제한 위반: 시나리오의 base는 actual만 허용."""


class InvalidScheduleError(DomainError):
    """Schedule DSL 형식 오류."""
