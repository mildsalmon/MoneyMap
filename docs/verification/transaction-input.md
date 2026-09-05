# 거래 입력 구현 검증 — 2026-09-05

승인된 [설계](../designs/transaction-input.md)와 [검증 계획](../designs/transaction-input-test-plan.md)을 구현했다. v0.6.0.0 릴리스 브랜치는 `mildsalmon/transaction-input-release`, 기준 main은 `2c983a6`(v0.5.0.0), 검증한 릴리스 커밋은 `23bd404`다. 최초 구현은 `mildsalmon/transaction-input`의 `d791f421` 기반에서 진행했으며, 아래 과거 QA·리뷰 수치는 각 실행 당시의 기록이다. 릴리스는 main 통합을 마친 `2db86fb`의 코드에 저장 경쟁·복구 테스트 5개와 버전·변경 기록을 더해 별도 작업공간에서 검증했다. 개인 DB는 사용하지 않았다.

## 구현

- 고정 차변·대변 계정 트리: 현재 사용 가능한 말단만 클릭 선택, 로컬 경로 검색, 그룹 접기, 키보드 라디오 선택, 선택 출처·현재 경로 표시.
- 아이템은 NFC와 동일한 30개 바깥 공백 문자로 정규화한다. 실제 저장 성공한 현재 원장 중 마지막 ID를 먼저 찾고 조합을 검증한다. 최신 조합이 분할·무효이면 이전 조합으로 대체하지 않는다.
- `GET /api/transaction-input/last-pair?item=...`, `GET /api/transaction-input/recent?limit=1..20`은 실제 원장의 user/legacy_unknown만 조회한다. last-pair 최대 2개 SQL, recent 최대 2개 SQL이며 최근 후보를 먼저 제한한 뒤 postings를 한 번에 집계한다. 입력 화면은 전체 거래 목록을 내려받지 않는다.
- 현금 설정 스키마 v3 다음에 실행되는 v4는 item_key, entry_origin, memo와 두 부분 인덱스를 추가한다. 규칙 출처와 정확한 개시잔액 구조를 분류하고 나머지 기존 기록은 명시적으로 확인한 뒤 불러온다. 새 열은 기존 백업·마이그레이션·저장 트랜잭션 경계에 포함한다.
- 메모는 아이템 아래 별도 필드이며 내역의 `메모 보기`에서 텍스트로 확인한다. 자동 조회는 날짜·금액·메모를 불러오지 않는다.
- 저장 중 새 초안을 보존하고 중복 제출을 차단한다. 변경 없는 성공한 초안만 금액·메모를 비운다. 실행취소 성공은 조합을 다시 조회하고, 실패 안내는 토스트가 교체되어도 유지한다.
- 분할 입력은 초안을 공유하며 부분 입력 행을 누락한 채 저장하지 않는다. 한 선택기만 펼치고 선택/닫기 후 해당 행으로 포커스를 돌린다. 부채 잔액 채움은 명시적 버튼으로만 수행한다.

## v0.6.0.0 최종 격리 실행 결과

- Backend: `cd backend && uv run pytest -q` — **373 passed**, 12.58초. 기존 Starlette/httpx 사용 중단 예고 경고 1개.
- Frontend: `cd frontend && MONEYMAP_E2E_BACKEND_PORT=8896 MONEYMAP_E2E_FRONTEND_PORT=5296 npm run e2e -- --timeout=180000` — **89 passed**, 12.5분. 최종 전체 실행에서 재시도 없음.
- Build: `cd frontend && npm run build` — TypeScript 검사와 Vite 프로덕션 빌드 성공.
- `git diff --check` — 통과.

테스트는 별도 임시 SQLite DB를 사용했다. 앞선 실패 실행에는 외부 글꼴 CDN 로드 timeout과 실패 뒤 남은 fixture 상태가 있었다. 최종 실행은 새 DB에서 시작했고, 관측된 CDN 지연을 반영해 CLI의 테스트 timeout만 180초로 지정했다. 제품 코드나 테스트 단언을 완화하지 않았다. E2E의 실제 저장 사례는 생성한 거래를 finally에서 정리한다. 로컬 원본 로그는 `/tmp/moneymap-isolated-ship-backend.log`, `/tmp/moneymap-isolated-ship-e2e-final.log`, `/tmp/moneymap-isolated-ship-build.log`이며 저장소에 포함하지 않는다.

## 주요 근거

| 검증 대상 | 실행 근거 |
|---|---|
| 정확한 키, 마지막 저장 순서, 8개 제한 제거, 삭제 후 복원, 최신 무효 조합 거절 | `backend/tests/test_transaction_input.py` |
| provenance, 메모 왕복, source 주입 거절, 오류 시 전체 롤백, 두 연결의 조회 스냅샷 | 같은 파일의 origin/HTTP/failure/snapshot 테스트 및 기존 persistence 회귀 |
| 기존 v3 데이터·스키마 보존 및 이전 버전부터 전체 업그레이드, 출처 backfill, 새 열·backfill·인덱스 단계 실패 후 재실행 | `backend/tests/test_transaction_input_migration.py`와 기존 migration/backup 테스트 |
| 5개 eligible + 200,000개 더 최신 rule 기록, 부분 인덱스 사용, 최근 조회 임시 정렬 없음, 20,000행 분할 요약 | `test_large_excluded_history_uses_partial_indexes_and_bounded_queries` |
| 직접 선택 보호, 응답 epoch, 저장 중 수정, 분할 변환·부분 행·0·잘못된 금액 | `frontend/e2e/transaction-input-state.spec.ts` |
| IME, 늦은 조회·저장, 이전 기록 확인, 같은 최근 아이템 재조회, 오류 복구, 실행취소 실패 | `frontend/e2e/transaction-input.spec.ts` |
| 저장 후 대시보드 이동·새 메모 보호, 지연 실패, 이탈·재진입 후 이전 저장 완료, 최근 목록 재시도 | `frontend/e2e/transaction-input-ship.spec.ts`의 5개 사례 |
| 실제 저장→재접속→마지막 조합→두 번째 저장→실행취소→이전 조합, 메모 내역 표시 | `real save, reload, last-pair recall, undo fallback and multiline memo history` |
| 1440/1024/721/720/390/320px, 긴 중복 이름과 경로, overflow 없음, 44px 항목, 포커스 가림 방지, reduced motion | `responsive widths, long duplicate paths, reduced motion and split accessibility` |
| 기본·분할 대표 상태 WCAG A/AA axe, 모바일 상단 요약·하단 저장, 낮은 viewport 일반 흐름 | 위 responsive 테스트와 `mobile sticky selection, search reset, keyboard choice, and accessibility` |
| 기존 계정/거래/시나리오/온보딩 회귀 | 기존 E2E 전체 및 백엔드 전체 |

## 리뷰와 한계

gstack-review의 코드 검토 및 독립 문맥 검토에서 5개 문제를 발견해 수정했다: 조회 실패 후 오래된 자동 선택, 언어별 공백 차이, 분할 모드 Enter 제출, 같은 최근 아이템 재조회 누락, 이전/분할 기록 안내. 재검토에서 수정이 확인되었다. 후속 검사에서 실행취소 실패 안내 유지와 화면 순서에 맞는 화살표 이동도 수정·검증했다. 실제 모델은 Codex 두 문맥이며 Claude 또는 외부 모델 리뷰를 수행했다고 주장하지 않는다.

모바일 키보드 대응은 화면 높이 축소와 visualViewport 처리로 에뮬레이션했고, 200%에 해당하는 720×450 CSS viewport를 검사했다. 실제 iOS/Android 키보드·기기 safe-area와 브라우저 자체 200% 확대를 직접 조작한 QA는 수행하지 않았다. 계획의 B/F 번호 37개는 요구사항 묶음이며 통과 테스트 수나 줄 단위 커버리지 수치가 아니다.

계획 완료 감사는 T1–T5와 B01–B18/F01–F19의 42개 항목 중 DONE 38, CHANGED 2(T2/B17 성능 테스트 파일 통합), PARTIAL 2(T5/F19 실기기 검증)다. 테스트 연결을 평가한 30/30 경로 묶음은 감사 상한 내 결과이며 계측한 줄 단위 커버리지가 아니다. 이번 릴리스 작업공간에서 별도 수동 브라우저 QA 패스를 새로 실행하지 않았으며, 아래 캡처와 브라우저 QA는 이전 구현 검증 기록이다. 최종 격리 E2E는 위 명령으로 새로 실행했다.

실제 구현 캡처: [데스크톱](assets/transaction-input-desktop.png), [모바일](assets/transaction-input-mobile.png). 긴 동일 이름과 서로 다른 경로의 테스트 데이터로 촬영했다.

후속 [브라우저 QA](transaction-input-qa.md)에서 모바일 저장 영역이 알림·실행취소를 가리는 문제 1건을 발견해 수정했다. 기본·분할 회귀 테스트 2개를 추가하고 전체 305 backend / 62 E2E 및 빌드를 다시 통과했다.

후속 [Pre-Landing Review](transaction-input-review.md)에서 이전 기록 확인·분할 행의 동명 계정 경로와 메모 글꼴을 보완했다. 자동 선택 재클릭과 부채 조회 복구를 포함한 테스트 6개를 추가해 전체 305 backend / 68 E2E 및 빌드를 통과했다. 당시 미커밋으로 남긴 리뷰 수정은 현재 릴리스의 기능 커밋 `476dc40`에 포함되어 있다.

추가 Red Team 재시도는 정상 완료됐다. 공백 없는 긴 아이템을 저장하면 모바일 실행취소가 화면 밖으로 밀리는 문제를 발견해 공통 알림의 줄바꿈·크기 제한을 수정했다. 기본·분할의 60자/2,000자 사례를 추가해 전체 305 backend / 72 E2E 및 빌드를 통과했다. 검토 에이전트의 수정 확인도 완료했으며, 당시 미커밋 수정은 현재 릴리스의 기능 커밋 `476dc40`에 포함되어 있다.
