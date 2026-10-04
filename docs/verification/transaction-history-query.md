# 거래내역 기간별 조회 — 구현 검증

Date: 2026-09-15
Branch: `feature/history-date-query`
Status: 아래는 기존 브랜치의 역사적 검증 기록이다. 최신 main 통합 결과는 마지막 2026-10-04 절을 참고한다.

## 구현 범위

- 최근 달력 한 달 기본 조회, 이번 달·지난달 빠른 선택, 날짜·태그 초안과 명시적 조회, 100건 이전/다음 페이지.
- 적용 조건을 URL에 저장하고 수정 저장·취소·Back에서 동일 조건의 페이지·초안·실제 스크롤·포커스를 복원한다.
- 전용 `GET /api/transaction-history`는 actual/posted 거래를 날짜와 태그로 먼저 제한한다. 건수와 페이지의 거래·분개·태그를 기존 요청 snapshot 안에서 읽는다.
- 기존 전체 거래 API와 모든 거래 종류를 유지한다. 새 스키마·마이그레이션·인덱스·의존성은 추가하지 않았다.
- 조회 실패 시 이전 행·건수·페이지를 숨기고 적용 조건으로 재시도한다. 태그 선택지는 독립적으로 재시도하며, 지연 응답이 정상 폼 높이와 스크롤을 바꾸지 않는다.
- 삭제 중복 요청을 차단한다. 응답 유실에는 성공/실패를 단정하거나 DELETE를 자동 반복하지 않고 읽기 재조회를 제공한다. 마지막 페이지 소멸 시 유효 페이지로 보정한다.
- 모바일은 기존 가로 스크롤 표를 사용한다. 공통 열 순서는 날짜/내역/금액/흐름/작업이며 별도 모바일 표·고정 열은 없다.

## 최종 실행 결과

| 검증 | 명령 | 결과 |
|---|---|---|
| 백엔드 전체 | `cd backend && uv run pytest -q` | 498 passed, 18.05초 |
| 프런트엔드 전체 | `cd frontend && MONEYMAP_E2E_BACKEND_PORT=8977 MONEYMAP_E2E_FRONTEND_PORT=5386 npm run e2e -- --reporter=line` | 164 passed, 2.4분 |
| 프런트엔드 빌드 | `cd frontend && npm run build` | 성공 |
| 공백/패치 검사 | `git diff --check` | 통과 |

E2E는 전용 포트와 `/tmp/moneymap-e2e-8977`의 합성 DB를 사용했다. 실제 개발 서버 8765/5173 또는 사용자 원장을 대상으로 테스트 쓰기를 실행하지 않았다. 기존 경고 2종(Starlette/httpx TestClient deprecation, 500kB 초과 번들)은 남아 있다.

## 핵심 근거

- `backend/tests/test_transaction_history.py`: 신규 20개. 날짜 양 끝·invalid 요청, 0/1/100/101/201건, 같은 날짜 ID 정렬·전체 순회, 매우 큰 페이지 보정, 태그 정확 일치, 기존 API/legacy 0원·환불·긴 메모 보존.
- 10,001건 합성 DB: 빈 결과는 1 SELECT, 비어 있지 않은 페이지는 4 SELECT, 페이지당 최대 100거래. 기존 날짜·태그 인덱스 사용을 실행 계획으로 확인했다. COUNT와 페이지 조회 사이 다른 연결이 쓰더라도 한 요청의 count/items가 같은 snapshot을 읽는다.
- `frontend/e2e/history-query-state.spec.ts`: 신규 9개. 월말·윤년·연도 전환, URL 검증 및 복귀 상태 whitelist.
- `frontend/e2e/history-query.spec.ts`: 신규 16개. 기본 날짜·서울/LA 시간대, 초안/Enter/페이지, 잘못된 URL, 태그 부분 실패, 응답 역전, 삭제 불확실성, 실제 API 201건의 수정 왕복·삭제 후 페이지 보정, 늦은 태그 로딩의 폼/스크롤 안정성.
- 기존 수정 테스트의 실제 거래 ID·분개·잔액 검증과 정확한 `.main.scrollTop` 복귀 검증을 유지했다. 과거 fixture에는 기간을 지정하고, 새 API/정규화된 URL에 맞춰 기존 목업·URL assertion을 변경했다.
- 390px와 1280px 합성 화면 스크린샷을 확인했다. 모바일 폼의 화면 넘침, 공통 열 순서, 44px 조회 버튼 및 history 영역 axe 검사 통과. 긴 메모는 접어서 표시하고 펼친 표만 가로로 스크롤한다.

## 한계와 다음 단계

- SELECT 횟수/계획·최대 반환 행 수를 검증한 것이며 실제 사용자 DB의 응답 시간이나 모든 데이터 분포의 성능을 측정했다는 의미는 아니다.
- 자동 브라우저 검증은 프로젝트의 Chromium 설정 기준이다. Safari/Firefox 및 실제 모바일 기기에서 검증하지 않았다.
- 사용자 인수 확인, 변경 코드 리뷰와 커밋·PR·배포는 남아 있다. [설계](../designs/transaction-history-query.md)의 T1~T5와 [테스트 계획](transaction-history-query-test-plan.md)을 함께 참고한다.

## 2026-09-17 코드 리뷰 후 수정

- 사용자 승인(A)에 따라 삭제 응답 유실 시 전체 거래의 삭제를 계속 막던 상태를 거래 ID별 보호로 변경했다. 불확실한 대상의 경고는 유지하고, 다른 거래는 삭제할 수 있다. 여러 대상과 기간/페이지 변경에서도 보호 상태를 유지한다.
- 날짜 수정으로 마지막 페이지가 없어지면 수정 결과 안내와 페이지 보정 안내를 각각 보존한다.
- `frontend/e2e/history-query.spec.ts`는 20개로 확대했다. 여러 삭제 응답 유실과 복구 GET 실패, 다른 페이지로 이동하는 날짜 수정, 기간 밖 이동, 마지막 페이지 소멸을 검증한다. 집중 실행 20 passed(16.9초), backend 전체 498 passed(14.63초), 프런트엔드 build 성공.
- 수정 후 전체 브라우저 테스트와 변경분 재리뷰 결과는 gstack 리뷰 기록에 남긴다. 동일 실행 환경의 리뷰이며, 별도 모델 교차 검토는 host 불일치 방지 장치로 실행하지 않았다. 외부 검토 미실행을 통과로 간주하지 않는다.
- 테스트는 8980/5390의 격리 서버와 합성 DB를 사용한다. 실사용 원장 변경, 커밋, PR, 배포는 이 리뷰 범위에 포함하지 않는다.

## 2026-10-04 최신 main 통합

- 기준 main `c8c2db3`에서 `feature/history-query-integration`으로 필요한 구현과 테스트만 통합했다. 기존 브랜치의 VERSION·CHANGELOG·계정 추천 설계는 덮어쓰지 않았다.
- 수정 복귀 E2E는 100건 페이지 조회에 맞추면서 최신 main의 초기 materialize 완료 대기를 유지했다.
- 전체 backend: **500 passed, 18.08초**. 전체 E2E: **202 passed, 2.9분**. 프런트엔드 production build 성공, `git diff --check` 통과.
- E2E는 18765/15173과 포트별 임시 DB를 사용했다. 최근 입력 더보기·계정 추천·대시보드 그룹화 회귀 포함.
- 재리뷰에서 반복 수정 왕복의 최신 초안 복원, History 전용 삭제 타임아웃, 화면 이동 후 삭제 진행/미확인 상태 보존을 보완했다. `history-return.regression-1.spec.ts`의 2개 회귀 테스트를 추가했다.
- **수정 후 최종 전체 검증:** backend **500 passed, 18.24초**, E2E **204 passed, 2.9분**, production build 성공. 7개 분야 전문 리뷰와 Red Team·독립 adversarial 리뷰를 거쳐 수정본을 다시 검토했다. 별도 모델/외부 프로세스 리뷰는 Codex 호스트 중첩 방지로 실행하지 않았다.
- 별도 브라우저 QA는 18865/15273, `/tmp/moneymap-history-qa-20261004.db` 합성 거래 105건으로 진행했다. 1페이지 100행 → 2페이지 5행, 결과 제목 포커스, 수정 취소 복귀, 두 번째 왕복의 미적용 종료일 보존, 지난달/직접 기간의 0건 표시를 확인했다.
- 1280×900과 390×844 스크린샷을 직접 확인했다. 모바일 body 390px, 표 영역 366px/내용 640px로 표만 가로 스크롤된다. 정상 흐름의 콘솔 오류는 0건이었다.
- QA 서버를 잠시 중단해 조회 실패 시 이전 행 숨김을 확인하고, 재시작 후 ‘다시 조회’로 100행 복구를 확인했다. 오류 유발 시 발생한 네트워크 오류는 의도한 검증이다.
- 화면 증거: `/tmp/moneymap-history-desktop.png`, `/tmp/moneymap-history-mobile.png`, `/tmp/moneymap-history-empty.png`, `/tmp/moneymap-history-error.png`. 임시 파일이므로 영구 배포 산출물은 아니다.
- v0.9.0.0 릴리스 준비 중 전체 검증을 다시 실행했다: backend **500 passed, 19.03초**, E2E **204 passed, 2.9분**, production build 성공(1.79초).
- 이후 추가한 `history-ship-coverage.spec.ts`는 집중 실행에서 **6 passed, 5.6초**였다. 이 결과는 위 전체 204개 실행과 별도이며, 추가 테스트를 포함한 전체 실행 완료를 뜻하지 않는다.
- TODO는 v0.9.0.0 구현 완료로 기록했다. 이 PR의 main 머지와 배포는 아직 대기 중이다.
