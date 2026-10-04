# 실제 반복규칙 수정 검증 (2026-10-04)

구현 브랜치: `feature/actual-rule-editor`, 기준: main `b20e224` (PR #14).
PR 생성·머지·배포는 이 작업에 포함하지 않았다.

## 자동 검증

- Backend 전체: **515 passed**, 15.32s. 기존 Starlette testclient 경고 1개.
- E2E 전체: **224 passed**. 추가 계정 검증 전·후 전체 실행 모두 통과. 최종 로그: `/tmp/moneymap-rule-final-e2e.log`.
- Frontend production build: **통과**, 1.37s. 기존 500kB chunk 권고 유지.
- `git diff --check`: 통과.

새 backend 15개: 월간 말일/윤년과 주간 기간, 미처리 과거 적용, 원래 거래/출처/처리일 보존,
필수·오래된 토큰, 두 편집 경합, 금액·일정·기간·계정 검증, 비원화 규칙 보호,
보관·다른 통화·그룹 계정 거부. 기존 materialization 경합 테스트는 409와 처리일 보존을 검증하도록 확장했다.
기존 active/archived live projection와 legacy snapshot 회귀 테스트도 통과했다.

새 E2E 14개: 원본 주간/날짜 채움, 취소, 모바일 월간31/종료일 해제, 503·account404 재시도,
409 최신 토큰을 사용한 재저장, 저장 응답 유실 후 조회로 확인(재전송 없음), 중복 제출/이동 잠금,
null·잘못된ID·500응답/확인 조회 실패, 규칙 삭제, 동일 계정 입력 거부, 실제 API 수정과 거래 보존.

## 브라우저 확인

실제 개발 장부 대신 `/tmp/moneymap-rule-qa-20261004.db`에 급여·통장·월급 규칙을 생성했다.
gstack browse로 `18870/15278` 서버에서 확인 후 두 서버를 종료했다.

- 1280×900: 편집 원본값과 안내, 금액 변경, 입력/버튼 배치 확인.
- 390×844: 단일 열 편집, 문서 폭 390/스크롤 폭 390, 전체 페이지 가로 넘침 없음.
- 300만→350만 원 저장 후 목록 반영, `edit-rule-1`로 포커스 복귀 확인.
- 브라우저 콘솔 오류 없음.
- 스크린샷: `/tmp/moneymap-rule-edit-desktop.png`, `/tmp/moneymap-rule-edit-mobile.png`, `/tmp/moneymap-rule-edit-saved.png`.

## 리뷰와 완료 범위

gstack review 체크리스트 및 native 에이전트의 testing, maintainability, security,
performance, API contract, design, simplification, red-team 관점을 적용했다.
OpenAPI의 조건부 헤더 설명, writer lock 안 단일 규칙 조회, 모바일 버튼 크기,
편집 후 포커스 복귀, 충돌 후 최신 토큰으로 재저장하는 테스트를 보강했다.
마지막 자체 검토에서 보관/통화가 다른 계정을 직접 API로 지정하는 경로도 차단했다.

별도 모델/외부 Codex 프로세스 검토는 실행하지 않았다. native adversarial pass는
소스 전체와 테스트 요약만 읽었으며, 테스트 실행 증거는 위 자동 검증과 구분한다.

설계의 편집 UI, 과거 불변·미처리분 정책, 원자적 조건부 저장, 오류/이동 보호,
회귀 테스트·브라우저 검증을 구현했다. 릴리스 버전 변경과 PR/머지는 후속 ship 단계다.
