# Scenario foundation — PR1 검증 기록

- 기준 설계: [scenario-lifecycle.md](../designs/scenario-lifecycle.md), 승인·engineering review 2026-09-05
- 작업 브랜치: `codex/scenario-foundation`
- 시작 base: `origin/main`의 `ce5e3e1` (원격 fetch 후 브랜치 생성)
- 작업 전 `TODOS.md`, 승인 설계 파일, 설계 이미지의 변경은 보존했다.

## 구현 범위

| Task | 결과 |
| --- | --- |
| T1 | FastAPI composition root와 accounts/transactions/rules/scenarios/reporting/status router 분리. SQLite accounts/transactions/rules/scenarios/reporting/materialization 분리. 기존 repository import는 compatibility export로 유지. 프론트 API를 core/types/feature modules로 분리하고 기존 `api` 소비 인터페이스 유지. |
| T2 | `user_version=0` 기존 스키마를 migration 1로 수용. migration별 DDL·데이터·user_version을 같은 transaction에 저장. pending migration이 있는 기존 파일 DB만 온라인 검증 백업한 뒤 변경. integrity_check, SHA-256 sidecar, fsync, atomic rename 및 디렉터리 fsync 적용. |
| T3 | 앱 전체 lock·공유 연결 제거. dependency가 요청마다 연결 생성·rollback·close. 읽기는 명시적 BEGIN snapshot, 쓰기는 BEGIN IMMEDIATE. migration 후 WAL. application service가 copy-on-fork 전체를 scenario UoW로 묶고 내부 writer는 commit하지 않음. 계정·materialize의 독립 transaction 경계 유지. |
| T4 | application error envelope와 SQLite busy 503/retryable 통일, FastAPI native 422 유지, `ApiError.context`와 원본 detail 보존. 계정 대상 존재 확인을 명령 규칙보다 먼저 수행하고 검사 ID 순서 고정. 기존 계정·거래·규칙 guard를 해당 write transaction 안에서 검사. pytest/build/E2E CI 추가. |

시나리오 생성 응답, copy-on-fork, 기존 전망 계산과 화면 이동은 PR1에서 유지한다. lifecycle 필드·aggregate version bump, actual 보호·보관·ETag guard, live-additive/legacy 변환, 새 전망·React Router는 PR2에 속한다. 일회성 예정 거래·복제는 PR3, 현금성 설정·현금 계산은 PR4다. 이 기록은 PR1 구현·로컬 검증 완료이며 전체 설계의 출시 완료를 뜻하지 않는다.

## 검증

| 명령 | 결과 |
| --- | --- |
| `cd backend && uv run pytest` | **205 passed**, skip 없음 |
| `cd frontend && npm run build` | 통과 |
| `cd frontend && MONEYMAP_E2E_BACKEND_PORT=8882 MONEYMAP_E2E_FRONTEND_PORT=5280 npm run e2e` | **12 passed** (기존 11개 + API client 계약 1개) |
| 변경 Python 파일 Ruff check | 통과 |
| `git diff --check` | 통과 |

pytest에는 기존 Starlette/httpx deprecation warning 1개가 남아 있다. GitHub Actions workflow는 추가했으며 원격 CI 실행 결과는 이 로컬 검증 기록에 포함하지 않는다.

### PR1 추가 검증 근거

- `backend/tests/test_migrations.py`: 고정된 이전 schema fixture에서 actual/scenario 규칙 없음·한쪽만·양쪽 모두, legacy 생성 거래의 fork 이전·당일·이후 보존. 현재 main의 account metadata/position/version 보존. 같은 날 daily backup과 별개 migration backup, checksum·integrity·복원·재실행·daily rotation 분리. permission/disk/integrity/fsync/rename 실패 시 startup 중단. migration DDL/데이터/user_version rollback. migration별 독립 commit, 동시 startup에서 한 번만 적용.
- `backend/tests/test_foundation_persistence.py`: 시나리오·규칙·거래·posting 중간·posted 확정 단계 실패 시 aggregate 전체 rollback 및 actual/다른 시나리오 보존. copy-on-fork 두 번째 규칙 저장 실패, 단일 commit, 중첩 UoW 거부와 interruption rollback. 두 연결 barrier로 busy 오류와 요청 연결 close, projection 중 concurrent actual writer의 이전 snapshot 유지 및 다음 조회 갱신. `sleep`·전역 request lock을 사용하지 않음.
- `backend/tests/test_error_contracts.py`: status/code/context, 대상 존재 우선순위, native 422, 빈 시나리오 이름, 모델 검증 오류, 없는 scenario 잔액, HTTP 헤더 보존.
- `frontend/e2e/api-contract.spec.ts`: 중첩 충돌 context, native 422 detail, 기존 문자열 오류 호환, AbortSignal 유지.
- 기존 계정 설정·개시잔액·materialize·시나리오·전망 테스트 및 11개 E2E 흐름 유지.

## 저장소 운영 계약

- Migration 목록은 append-only다. 이미 배포된 migration을 수정하지 않고 다음 항목을 추가한다.
- `migration-v*-to-v*-*.db`와 `.db.sha256.json`은 검증된 migration 복구본이며 daily rotation 대상이 아니다. `.partial` 파일은 복구본이 아니다.
- pending migration이 없는 일반 기동에서는 migration backup을 만들지 않는다. 비어 있는 새 DB는 복구할 기존 스키마가 없으므로 backup 없이 migration을 적용한다.
- `init_db()`는 idle connection을 요구한다. 호출자의 미완료 transaction을 암묵적으로 commit하지 않는다.
- `create_app(':memory:')`는 수명 종료 시 제거되는 임시 파일 DB를 사용한다. 테스트에서도 production과 같은 독립 연결·WAL 의미론을 검증하기 위함이다. 저장소 단위 테스트의 `connect(':memory:')`는 SQLite 메모리 DB 그대로다.
- projection 성능 benchmark의 15/18 SQL·p95 gate는 설계의 PR2/PR4 범위이며 PR1에서 새 계산 계약을 먼저 도입하지 않는다.

## Ship 검토 보완 (2026-09-05)

규칙 수정과 materialize가 겹칠 때 저장된 생성 날짜가 되감겨 거래가 중복 생성되는 경로를 수정했다. 일반 규칙 수정은 DB의 watermark를 보존하고, materialize는 규칙 조회·계획 수립 전에 writer lock을 획득한다. 두 연결 barrier 회귀 테스트가 이 순서를 검증한다. 일반 SQLite 오류의 내부 SQL 비노출, 백업 마지막 rename·directory fsync 실패, transaction writer 거부 경로도 추가 검증했다.

전문가 검토 및 독립 fresh-context Codex 검토 후 추가 결함은 없었다. 점검한 30개 경로 모두에 테스트가 연결되어 있으며, 이는 표본 기반 평가이지 저장소 전체의 계측 coverage가 아니다. 별도 Claude 모델 검토나 nested Codex CLI 검토를 실행했다고 주장하지 않는다.
