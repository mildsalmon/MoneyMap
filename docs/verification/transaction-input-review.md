# 거래 입력 Pre-Landing Review — 2026-09-05

**DONE_WITH_CONCERNS.** 기능·표시 문제 3건과 테스트 공백 2건을 보완했다. 확인한 미해결 코드 결함은 없다. 사용량 오류가 났던 Red Team 검토는 재시도에서 완료했고, 긴 아이템의 모바일 실행취소 문제를 추가로 찾아 수정했다. 실기기 모바일 검증은 남아 있다. 이후 최신 `main` 통합과 통합 트리 전체 검증을 완료했으며, 아래 시작 범위와 수치는 통합 전 리뷰 시점의 기록이다.

## 범위

- 브랜치: `mildsalmon/transaction-input`, 시작 HEAD `6543976`.
- GitHub의 기본 브랜치 `main`을 fetch했다. PR은 아직 없다.
- 비교 기준은 `origin/main`과 HEAD의 merge-base `d791f421891bb0d020a8b193794a95c1528cd6e5`다. 기준점 이후 main에 들어간 별도 변경은 이 기능 diff에 섞지 않았다.
- 시작 diff: 44개 파일, +2,342 / −378줄. 전체 코드·테스트·문서 변경을 읽고 호출자와 기존 저장·조회·마이그레이션 경계를 확인했다.
- Scope Check: CLEAN. 의도와 구현은 클릭 계정 선택, 마지막 저장 조합 하나, 메모, 초안 보존, 분할 입력, 제한 조회, 모바일 저장 접근성이다. 다른 시나리오 기능을 추가하지 않았다.
- 이번 수정은 리뷰 당시 아래 파일에 **미커밋 상태**로 남겼다. 이후 WIP 체크포인트로 보존하고 최신 `main`을 통합했다.

## 발견 사항과 조치

### 1. [P2] 동명 계정의 확인 화면에 경로 누락 — confidence 10/10, fixed

`frontend/src/views/TxnInput.tsx:136`의 이전 기록 확인은 `${name(pair.debit_account_id)} → ${name(pair.credit_account_id)}`만 표시했다. 분할 행 버튼도 `name(row.account)`만 표시했다. 서로 다른 부모의 계정 이름이 같은 경우 `기타 → 기타`로 보여 어떤 계정인지 구분할 수 없었다.

승인 설계의 `한 쌍·현재 경로` 기준대로 기존 `model.paths`를 재사용했다. 이제 `비용 > 식비 > 기타 → 비용 > 교통 > 기타`를 확인하고, 선택기를 닫은 분할 행에도 각각의 전체 경로가 남는다. 계정 ID와 저장 동작은 바꾸지 않았다.

### 2. [P3] 메모 글꼴 상속 누락 — confidence 10/10, auto-fixed

`frontend/src/views/transaction-input.css:8`은 `.txn-page textarea{resize:vertical;...}`로 크기와 줄 높이만 지정했다. 기존 전역 폼 글꼴 규칙은 textarea를 포함하지 않는다. 실제 Chromium 계산값은 아이템이 `"Pretendard Variable", Pretendard, sans-serif`, 메모는 `monospace`였다.

해당 textarea에 `font-family:inherit`를 추가했다. 승인된 Pretendard와 16px 입력 크기를 유지한다.

### 3. [P3] 자동 선택된 계정 재클릭의 회귀 검증 누락 — confidence 10/10, fixed

`frontend/src/views/TransactionAccountPicker.tsx:56`의 `onClick={() => { if (value === a.id) onSelect(a.id); }}`는 이미 선택된 항목을 직접 선택으로 잠그는 별도 경로다. 기존 테스트는 다른 계정을 고르거나 이미 수동인 항목을 검사했다.

자동 선택된 항목을 `click()`으로 다시 선택한 뒤 아이템을 바꾸는 테스트를 추가했다. 재클릭한 차변은 남고, 직접 선택하지 않은 대변은 해제되는 것을 검증한다. `check()`는 이미 선택된 라디오를 건너뛰므로 이 검증에 쓰지 않는다.

### 4. [P3] 부채 잔액 없음·조회 실패의 회귀 검증 누락 — confidence 10/10, fixed

`frontend/src/views/TxnInput.tsx:125`의 `if (balance < 0) ... else setDebtMessage(...)`와 catch 복구 분기는 기존 부채 테스트가 다루지 않았다.

잔액 0, 양수 잔액, 503 오류의 세 사례를 추가했다. 기존 입력 50원 유지, 안내 표시, 버튼 재활성화, 다음 정상 조회로 9,000원 채우기까지 검증한다.

모든 신규 검증은 `frontend/e2e/transaction-input-review.spec.ts`에 있다. 사용자 승인 설계의 경로·글꼴 기준과 기존 검증 범위를 완성하는 수정이며, 후속 `계속 작업해줘` 요청에 따라 수정과 검증을 마무리했다.

### 5. [P2] 긴 아이템 저장 시 모바일 실행취소가 화면 밖으로 밀림 — confidence 10/10, fixed

Red Team 재시도에서 `frontend/src/views/TxnInput.tsx:101`이 저장 알림에 넣는 공백 없는 긴 아이템을 검사했다. 390px 화면에서 실행취소 버튼이 x=551.95px에 표시돼 클릭할 수 없었다. 공통 토스트의 flex 문구에 줄바꿈·축소 제약이 없었던 것이 원인이다. 60자 연속 영문 입력으로 Playwright에서도 수정 전 실패를 재현했다.

`App.tsx`에서 문구를 `toast-message`로 감싸고, `tokens.css`에서 화면 너비 제한, 줄바꿈, 문구 높이 제한과 스크롤을 적용했다. 실행취소 버튼은 축소되지 않게 했다. `transaction-input-toast.regression-1.spec.ts`를 일반 문구·60자·2,000자 × 기본·분할 입력의 6개 사례로 확장했다. 각 사례에서 390/320/720px 화면의 버튼 전체 경계와 실제 클릭 대상, DELETE 요청을 확인한다. Red Team 에이전트도 수정과 회귀 테스트를 읽고 해결을 확인했다.

## 검증 결과

| 검사 | 결과 |
|---|---|
| 새 테스트, 수정 전 | 4 passed / 2 failed: 경로와 글꼴 문제를 실제 재현 |
| 새 테스트, 수정 후 | **6 passed**, 7.5초 |
| `cd backend && uv run pytest -q` | **305 passed**, 21.89초, 기존 Starlette/httpx 경고 1개 |
| `cd frontend && MONEYMAP_E2E_BACKEND_PORT=8876 MONEYMAP_E2E_FRONTEND_PORT=5276 npm run e2e` | **68 passed**, 약 1.2분 |
| `cd frontend && npm run build` | TypeScript 검사·Vite 빌드 성공 |
| `git diff --check` | 통과 |

위 표는 최초 리뷰 완료 시점의 결과다. Red Team 보완 후 재검증:

| 검사 | 결과 |
|---|---|
| 긴 아이템 회귀, 수정 전 | **1 failed**, 60자 아이템의 실행취소 버튼이 화면 경계를 벗어남 |
| 확장된 모바일 알림 회귀, 수정 후 | **6 passed**, 9.8초 |
| Backend 전체 | **305 passed**, 21.91초, 기존 경고 1개 |
| E2E 전체 | **72 passed**, 약 1.5분 |
| TypeScript·Vite 빌드 / `git diff --check` | 통과 |

모든 DB 테스트는 격리된 임시 DB를 사용했다. 이전 QA의 62개 통과 기록은 당시 결과이며, 이번 68개와 혼동하지 않는다.

## Plan completion audit

Plan: `docs/designs/transaction-input.md`, 검증 요구사항: `docs/designs/transaction-input-test-plan.md`.
아래는 승인 문서의 구현 산출물을 묶어 추적한 결과다. 테스트 요구사항 37개 묶음의 각 세부 사례가 전부 실행됐다는 선언이나 줄 단위 커버리지 수치가 아니다.

| 구현 항목 / 종류 | 상태 | 근거 |
|---|---|---|
| 고정 차변·대변 클릭 트리 / CODE | DONE | `TransactionAccountPicker.tsx`, `TxnInput.tsx` |
| 현재 활성 말단·경로·영속 순서 / CODE | DONE | `accountPickerModel`, `accountTree`, `validateDraft` |
| NFC·공통 바깥 공백 키 / CODE | DONE | 양쪽 `normalize_item_key` / `itemKey`, `test_exact_key`, whitespace identity test |
| actual/user·legacy 최신 ID 한 건 / CODE | DONE | `SqliteTransactionInputQueries.last_candidate` |
| 최신 무효·분할 후보에서 이전 후보 미복원 / CODE | DONE | `validate_latest_pair`, `test_invalid_latest_never_falls_back` |
| legacy 명시 확인·동명 경로 / CODE | DONE | `applyPair`, 이전 기록 확인, 신규 duplicate names test |
| 원장 삭제 후 surviving 기록 조회 / CODE | DONE | 별도 기억 테이블 없음, latest save/undo roundtrip tests |
| item_key·origin·memo와 두 인덱스 / MIGRATION | DONE | `migrate_transaction_input`, migration rollback tests |
| 기존 백업·쓰기 원자성 유지 / CODE | DONE | `init_db`, `_insert_txn`, `test_failure_rolls_back_memo_and_metadata` |
| 새 조회 API·포트·응답 타입 / CODE | DONE | router/app service/ports, HTTP contract test |
| 최신 계정 재검사 / CODE | DONE | `SqliteTransactionRepository.save`, `test_save_rechecks_current_accounts_without_partial_write` |
| T1: 불완전 분할 행을 생략하지 않고 차단 / CODE·TEST | DONE | `validateDraft`, split mode/partial-row tests |
| T2: 기억 대상 부분 인덱스와 조회 비용 / CODE·TEST | CHANGED | 별도 performance 파일 대신 `test_transaction_input.py::test_large_excluded_history_uses_partial_indexes_and_bounded_queries`에 통합 |
| T3: 메모 저장·내역·초안 보존 / CODE·TEST | DONE | POST/DB/find_by_scenario/History, memo roundtrip and pending-save tests |
| T4: 한 분할 선택기·검색 초기화·초점 복귀 / CODE·TEST | DONE | split picker, 검색 빈 상태, split conversion/accessibility tests |
| T5: C 반응형 배치·키보드 / CODE·TEST | PARTIAL | 반응형·짧은 viewport·axe 및 실제 toast hit 확인 완료. 실제 iOS/Android 키보드·safe-area·브라우저 자체 200% 확대 미검증 |
| 부채 명시 채우기·늦은 응답·실패 복구 / CODE·TEST | DONE | `fillDebt`, 기존 late response test와 신규 3개 recovery cases |
| 최근 5건·최대 20건 제한 조회 / CODE·TEST | DONE | `recent`, `test_recent_limits_and_no_memo_payload` |
| 설명·변경 기록 / DOCS | DONE | CHANGELOG / DESIGN / CLAUDE / 구현·QA·이번 검토 문서 |

기존 TODOS의 태그 분리, 전체 잔액 조회 최적화, 원장 대사 등은 이 기능 범위 밖이다. 새로 연기한 코드 결함은 없고 TODOS.md는 수정하지 않았다.

## 검토 출처와 한계

- 주 검토: SQL·데이터 안전, 쓰기/읽기 경계, 비동기 응답과 초안 소유권, 타입·상태 소비자, 문서·승인 범위.
- 전문 렌즈 8개 완료: testing 2건, design 2건; maintainability/security/performance/data-migration/api-contract/simplification은 추가 발견 없음. 초기 품질 점수 **8/10**, 조치 후 **10/10**. 이 점수는 발견 건수에 따른 스킬 계산값이다.
- 동시/스레드 한도로 3개 에이전트에 역할을 순차 배정했다. 8개 새 문맥 또는 서로 다른 모델 8개를 쓴 것이 아니다.
- 별도 Codex in-host adversarial pass는 전체 운영 코드 diff를 재검토해 추가 재현 가능한 결함을 찾지 못했다. 해당 패스에서 테스트·fixture는 summary mode로만 읽었다. 주 검토와 testing specialist는 테스트 전체를 읽었다.
- 추가 Red Team 첫 호출은 `You've hit your usage limit` 오류로 실패했다. 사용자의 재시도 요청 후 같은 에이전트가 정상 실행되어 현재 작업 트리와 미커밋 수정을 검토했다. 긴 아이템 알림 문제 1건을 재현했고 수정 확인까지 완료했다. 저장·실행취소 경쟁, 조회 응답 소유권, 분할 전환, 부채 채움, 출처와 오류 경계에서는 추가 결함을 확인하지 못했다. 이 경계 검토는 코드 분석이며 모든 경쟁 상황을 부하 테스트한 것은 아니다.
- Codex 호스트 내부 실행이므로 스킬 지침에 따라 nested Codex CLI 패스를 생략했다. Claude 또는 외부 모델 검토는 수행하지 않았다.
- `slop:diff`는 저장소에 스크립트가 없어 생략했다. PR이 없어 Greptile 댓글도 없다.
- 이 리뷰 뒤 `main`의 **0.5.0.0**까지 병합해 현금성 설정 마이그레이션을 v3, 거래 입력 마이그레이션을 v4로 순서화했다. 통합 트리에서 backend **373 passed**, frontend E2E **84 passed**, TypeScript·Vite build와 `git diff --check`를 통과했다. 최종 릴리스 버전은 ship 단계에서 조정한다.

## Ship 최종화

최종 ship 검토에서 일반 거래 payload 모양만으로 시스템 개시잔액 출처를 얻을 수 있던 우회, 라우트 재진입 중 동일 저장 요청의 중복 전송, 무제한 본문·필드·분개·금액을 추가로 발견해 수정했다. 일반 거래 repository는 시스템 계정을 항상 거부하고 개시잔액은 전용 경로만 사용한다. 동일한 처리 중 저장 Promise는 화면 생명주기 밖에서 공유하며, 통신 단절 뒤에는 승인 설계대로 자동 재제출 없이 거래 내역 확인을 안내한다.

입력은 strict 정수와 안전 합계, 설명 2,000자, 메모 10,000자, 분개 100개, 본문 64KB로 제한한다. 본문 제한은 `Content-Length`를 속인 요청도 실제 바이트 수로 차단한다. E2E는 외부 폰트 CDN을 공통 fixture에서 대체하며 별도 서울 timezone context에도 같은 경계를 적용한다.

수정 후 Red Team·적대적·testing 재검토에서 미해결 finding은 없다. 최종 결과는 backend **377 passed**, frontend E2E **90 passed**, TypeScript·Vite build와 `git diff --check` 통과다. 실제 iOS/Android 키보드·기기 safe-area·브라우저 자체 200% 확대는 기존과 같이 자동화 범위 밖이다.

Prior learnings applied: `transaction-input-mobile-toast-layering`, `vite-api-route-mock-module-collision` (각 confidence 9/10, 2026-09-05). 이번에는 동명 계정 확인에 전체 경로가 필요한 이유를 `transaction-confirmation-needs-account-paths`로 기록했다.
