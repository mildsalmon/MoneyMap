# Scenario lifecycle — PR2 검증 기록

- 기준 설계: [scenario-lifecycle.md](../designs/scenario-lifecycle.md), 승인·engineering review 2026-09-05
- 선행 구현: [scenario-foundation.md](scenario-foundation.md), PR1/T1~T4
- 검증 대상: `codex/scenario-lifecycle` 브랜치, 기반 main `74ed9b2` (PR1 머지). 기능 커밋 `518dd4c`, 성능 CI 커밋 `bc76daa`, legacy 성능 수정 `12e9cab`, 화면 경쟁 조건 수정 `d90918c`. v0.3.0.0 릴리스 커밋 `24fb3e0`까지 원격 브랜치에 푸시했고 PR 게시를 준비 중이다.

## 구현 범위

| Task | 구현 내용 |
| --- | --- |
| T5 | 최신 actual 규칙과 시나리오 전용 규칙을 조립하는 `EffectiveRuleResolver`, 한 read snapshot의 `ProjectionInputs`, 공유 `ProjectionEvent` 전개와 일 마감 순자산·월별 수입/지출 계산. 3·6·12개월, 말일 당김, fork 당일 actual 마감 및 다음 날 전망 시작. |
| T6 | 이름·설명 수정, 보관·복원·영구 삭제, actual 보호, 시나리오 aggregate version과 리소스별 strong ETag, 전용 규칙 nested CRUD, actual-only generic endpoint, legacy 분류·변환. Migration 2에서 lifecycle 필드·revision·인덱스·재사용하지 않는 시나리오 ID 할당 상태 도입. |
| T7 | 전체 화면 React Router 전환, 시나리오 목록·상세·보관함, 개요/가정/정보 탭, legacy 분류 화면, 삭제 영향 재확인, 요청 취소·오래된 응답 차단, 키보드·포커스·720px·axe 검증. |

PR3의 시나리오 복제·일회성 예정 거래 생성/수정/삭제 화면과 API, PR4의 현금성 계정 설정·현금 곡선·부족 진단은 포함하지 않는다. 기존 시나리오 거래 중 보존한 일회성 가정은 전망 입력으로 읽지만, 새 예정 거래 편집 기능의 출시를 뜻하지 않는다. `capabilities.scenario_liquidity=false`이며 응답에 `cash`와 `cash_config_revision`을 제공하지 않는다.

## Migration 2와 legacy 처리

- PR1의 순서 있는 migration runner가 기존 DB의 pending migration 전에 검증된 migration 전용 backup을 만든다. daily backup 유무와 무관하며 backup 실패 시 schema 변경 전에 기동을 중단한다.
- lifecycle schema 변경과 `user_version=2`는 같은 migration transaction에 속한다. 실패 시 함께 rollback하고, 성공 뒤 런타임 WAL을 사용한다.
- 실제 규칙과 시나리오 규칙이 모두 있으면 복사본의 출처를 추측하지 않고 `legacy_snapshot`으로 남긴다. 규칙이 한쪽에만 있어도 fork 당일·이전 일회성 거래의 날짜 충돌이 있으면 명시적 분류가 필요하다.
- 분류 화면은 각 legacy 규칙의 폐기/유지와 날짜 충돌 거래의 이동/삭제를 모두 요구한다. actual 후보는 참고 정보이며 자동 선택하지 않는다. actual 후보 변경만으로 변환을 stale로 보지 않는다.
- 변환은 mode·version 변경, generated 거래 제거, 충돌 거래 이동/삭제, 선택한 규칙 제거를 하나의 UoW에 묶는다. 미결정·stale·실패 상태에서 부분 변환을 남기지 않아야 한다.
- 자동 live-additive 전환이 가능한 행은 전용 규칙과 fork 이후 일회성 거래를 보존하고 과거 generated 거래를 제거한다. 변환 후 규칙 전개와 저장된 generated 거래를 이중 합산하지 않는다.
- 삭제된 시나리오 ID를 재사용하지 않아 과거 URL과 ETag가 새 시나리오를 가리키지 않게 한다.

## 검증 근거

| 파일 | 검증 범위 |
| --- | --- |
| `backend/tests/test_live_projection.py` | 손계산 3·6·12개월 golden case, 1월 31일 경계, fork 이후 actual 거래 제외, 끝난 규칙의 0회 발생, 보관 시나리오의 최신 actual 규칙 반영, 시작 잔액 정정·revision, SQL budget, 같은 날 점 중복 방지, 자산 간 이체 중립성과 음수 환불 월 집계 Hypothesis 속성. |
| `backend/tests/test_scenario_lifecycle.py` | actual 보호·존재 우선순위, 불변 필드, version 충돌, 보관/복원 목표 상태 멱등성, nested 소유권, generic actual-only 경계, ETag 400/412/428, 삭제 단계별 rollback, 같은 version writer 단일 승자, legacy 완전성·stale·변환, 규칙 update/delete와 legacy 변환 rollback matrix, 삭제 ID·ETag 재사용 방지. |
| `backend/tests/test_migrations.py` | 기존 schema와 actual/scenario 규칙 조합, generated 거래·날짜 충돌 분류, metadata 보존, 검증 backup·복원·재실행, migration 실패·동시 startup. |
| `backend/tests/test_actual_ownership.py`, `test_lifecycle_migration.py` | 실제 CRUD와 ID 재사용의 소유권 경쟁, 규칙 전체 검증, migration 2 중간 실패 rollback과 재시도, 규칙이 없는 legacy 날짜 충돌. |
| `backend/tests/test_foundation_persistence.py` | 요청별 연결, projection 중 actual writer와 동시 읽기 snapshot·revision 일치, UoW rollback과 기존 materialize 원자성. |
| `frontend/e2e/query-cancellation.spec.ts` | 기존 대시보드·거래내역·규칙·계정·입력 화면의 이탈 취소와 재진입, 실패 상태·명시적 재시도, 입력 초안 유지. 초기 materialize 완료 후 검증해 startup 갱신과 오류 주입을 분리한다. |
| `frontend/e2e/scenario-lifecycle.spec.ts` | 생성→개요→규칙→정보→보관→복원→삭제, 영향 충돌 후 수동 재확인, 직접 링크·새로고침·뒤로가기·404, 720px·axe, 늦은 전망 응답 차단, 명시적 legacy 폐기, 저장 충돌 때 초안·포커스 보존. |

### 실행 결과

| 명령 | 최종 결과 |
| --- | --- |
| `cd backend && uv run pytest` | 267 passed |
| `cd frontend && npm run build` | 통과 (Vite 6.4.3) |
| `cd frontend && MONEYMAP_E2E_BACKEND_PORT=8882 MONEYMAP_E2E_FRONTEND_PORT=5280 npm run e2e` | 39 passed (37.1s) |
| `git diff --check` | 통과 |

실제 사용자 DB와 기존 문서 작업은 변경하지 않았다. E2E는 포트 8882/5280과 `/tmp/moneymap-e2e-8882`의 격리 DB를 사용한다. 원격 CI는 브랜치 푸시로도 실행되며, 최종 결과는 로컬 검증과 별도로 확인한다.

## 성능 측정

표준 명령은 `cd backend && uv run python tests/benchmark_projection.py --warmups 5 --samples 30 --months 12`다. fixture 생성은 측정에서 제외하고 5회 예열·30회 측정의 nearest-rank p95를 기록한다. fixture는 계정 250개, actual 거래 50,000개, actual 규칙 200개, 시나리오 규칙 100개, 보존된 일회성 거래 500개다.

원본 표본과 환경: [base JSON](assets/scenario-lifecycle-base.json), [head JSON](assets/scenario-lifecycle-head.json). 같은 장비에서 main과 작업 트리를 순차 측정했다.

| 측정 | PR1 base | PR2 head |
| --- | ---: | ---: |
| service p95 | 2,364.86ms | 159.05ms |
| API p95 | 2,786.87ms | 173.28ms |
| service SQL statements | 100,511 | 9 |
| API SQL statements | 100,511 | 9 |

- 관측 환경: macOS 26.5.1 arm64, Python 3.13.3, SQLite 3.47.1. 승인 설계의 Python/SQLite 기준 버전과 다르므로 기준 장비의 동일 환경 측정을 대신한다고 주장하지 않는다.
- base는 기존 historical/baseline/snapshot 응답, head는 새 net-worth/monthly 응답이다. 같은 fixture의 릴리스 전후 비용 비교이며 동일 응답 계약의 미세 최적화 비교는 아니다.
- 서비스와 API 요청 연결을 각각 추적했다. read transaction의 BEGIN/ROLLBACK을 포함해 모두 9 SQL로 15 SQL 제한을 통과했다. service/API p95는 로컬에서도 300/500ms 이내이며 base 대비 비율 0.067/0.062로 25% 회귀 제한을 통과했다.
- CI는 같은 runner에서 base/head를 측정하고 `scripts/compare-projection-benchmarks.py`로 15 SQL 및 p95 회귀율 25% 제한을 확인하도록 구성한다. PR4의 18 SQL·현금성 계산 gate는 아직 적용하지 않는다.

별도 재검토에서 기존 `legacy_snapshot` 대시보드가 선택한 시나리오마다 actual 거래와 분개를 반복 조회하는 문제를 수정했다. legacy 거래·분개는 JOIN으로 읽고, actual 입력과 변동지출 집계는 요청 안에서 한 번 공유한다. 실제 거래 10개와 1,000개에서 actual-only 8 SQL, legacy 1개 15 SQL, 3개 25 SQL로 각각 동일했고 개별 분개 조회는 0회였다. 이 수치는 복수 곡선의 호환 대시보드 측정이며 위 단일 시나리오 API의 15 SQL gate와 구분한다. 회귀 테스트는 actual과 owned 거래량을 함께 101배 늘려 쿼리 수 불변과 동일 입력의 동일 곡선을 확인하며, 기존 legacy 손계산 golden도 유지한다.

## 브라우저 검증

격리된 QA DB와 포트 8883/5281에서 생성 → 추가 급여 가정 → 개요 차이 → 보관 → 삭제 흐름을 직접 조작했다. 1280px/720px 화면, 월별 비교 막대와 표, 읽기 전용 정보, 삭제 영향과 포커스를 확인했다. 상세 기록은 로컬 `.gstack/qa-reports/qa-report-scenario-lifecycle-2026-09-05.md`에 있다.

검토 중 발견한 ID 재사용·actual CRUD 경쟁 조건·충돌 초안 복구·metadata 응답 순서·서울 날짜 표시·삭제 대화상자 배경 클릭·삭제 후 불필요한 상세 GET을 수정하고 회귀 테스트로 검증했다. Ship 재검토에서는 삭제 오류 후 포커스, 저장·보관·복원 중 다른 시나리오로 이동하는 경쟁 조건도 수정했다. 후자는 수정 전 E2E 실패를 재현한 뒤, 현재 URL·초안 유지와 늦은 이전 상세 GET 0회를 확인했다.

## 추가 코드 리뷰

`gstack-review`에서 PR2 T5~T7의 완료 상태(3/3), 보안·마이그레이션·API·성능·테스트·유지보수·디자인·단순화 관점과 별도 실패 경로를 검토했다. 발견한 네 항목을 수정했으며 미해결 항목은 없다.

- `adapters/sqlite/projection.py`, `app_services/projection.py`: legacy 거래 N+1 조회와 선택한 시나리오별 actual 집계 반복을 제거했다. 위 쿼리 수 검증과 0이 아닌 변동지출 손계산을 통과했다.
- `frontend/src/views/Scenarios.tsx`: 시나리오 생성 응답이 늦게 도착해도 현재 화면의 URL·초안을 바꾸지 않도록 목록 방문별 수명을 검사한다. 보관함을 거쳐 재진입한 새 방문도 구분한다.
- `frontend/src/views/scenarios/ScenarioRules.tsx`: 규칙 저장 중 입력·취소·다른 규칙 편집을 잠가 응답 대기 중 입력한 내용을 이전 요청이 지우는 문제를 방지한다.
- `TODOS.md`: PR2에서 완료한 child mutation·legacy 변환·영구 삭제를 미래 계획으로 설명하던 문구를 정정했다. 공통 UoW 확대 재평가 항목은 열린 상태로 유지한다.

새 화면 회귀 세 건은 수정 전 실패를 재현했고, 수정 후 재진입 사례까지 네 건이 통과했다. 최종 코드에서 전체 pytest 267개, E2E 39개, production build 및 변경 Python 파일 Ruff 검사가 통과했다. 리뷰는 Codex의 같은 모델 계열 에이전트로 수행했으며 외부 모델 교차 검증은 실행하지 않았다. adversarial pass에서 테스트·fixture는 요약으로만 읽었고, 테스트 전문 검토와 실제 실행은 별도로 수행했다. 이후 ship에서 리뷰 수정은 기능별 커밋으로 정리했다. 최신 main 병합 확인 후 전체 검증을 다시 통과했으며, v0.3.0.0 버전을 확정하고 릴리스 커밋을 푸시했다.

## 다음 배포 단계

`gstack-ship`에서 문서 동기화를 마친 뒤 PR을 생성하고 최종 원격 CI 결과를 확인한다. 이 문서는 원격 CI 통과나 PR2 머지를 주장하지 않는다.
