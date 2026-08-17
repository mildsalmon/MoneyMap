"""도메인 invariant 위반 시 발생하는 예외들.

어댑터(FastAPI)는 이 예외들을 잡아 사용자에게 "어느 필드가 어느
invariant를 어겼는지" 인라인 에러로 보여준다 (UI 스펙 D9).
"""


class DomainError(Exception):
    """모든 도메인 오류의 베이스.

    ``code``는 HTTP와 SQLite trigger가 공유하는 안정된 계약이다. 기존
    호출부의 ``DomainError(message)``도 그대로 동작한다.
    """

    code = "domain_error"
    status_code = 400

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code


class DomainValidationError(DomainError):
    """요청 값이나 계정 형태가 허용되지 않음."""

    code = "validation_error"
    status_code = 400


class DomainNotFoundError(DomainError):
    """요청한 도메인 객체가 없음."""

    code = "not_found"
    status_code = 404


class DomainConflictError(DomainError):
    """현재 저장 상태와 요청 전환이 충돌함."""

    code = "conflict"
    status_code = 409


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
