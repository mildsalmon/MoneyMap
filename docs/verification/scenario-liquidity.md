# Scenario liquidity — PR4 검증

2026-09-05, 승인 설계 `docs/designs/scenario-lifecycle.md`의 T10~T12 구현. 기준은 PR3가 병합된 `origin/main` (`6c78892`), 작업 브랜치는 `codex/scenario-liquidity`다.

## 구현 계약

- **T10:** migration 3에서 `accounts.include_in_cash`(기본 false, CHECK 0/1)와 `cash_config_revision`을 추가한다. 기존 migration runner의 사전 백업·DDL rollback·user_version 원자성을 재사용한다. 기존 계정과 표준 시드는 모두 미선택이다.
- 활성·비시스템·비그룹·자식 없는 자산 계정만 선택한다. 보관된 자식도 말단 판정에 포함한다. create/settings/reparent/placeholder/archive/restore와 seed의 SQLite 쓰기를 보호한다. DB 트리거는 직접 SQL에도 같은 제약을 적용한다. 선택 상태에서 자식 추가는 `cash_account_parent_forbidden`, 그룹 변경은 `cash_account_must_be_leaf`, 보관은 `cash_account_selected`로 거부한다.
- 계정 설정의 기존 version 계약과 응답을 유지한다. `include_in_cash`는 현행 UI가 명시적으로 보내며, 이전 클라이언트가 생략하거나 null을 보내면 기존 선택을 보존한다. 이름·부모 변경이 선택을 해제하지 않는다. UI는 선택 가능한 계정에 설명과 체크박스를 제공하고 그룹에는 하위 활성 자산 말단 계정의 포함 개수를 표시한다.
- **T11:** 순자산·현금·수입/지출은 한 번 확장한 이벤트를 함께 접는다. 현금은 선택 계정 posting 합이며 선택 계정끼리 이체는 중립이다. 일 마감만 진단하므로 같은 날 지출·회복을 항목별 부족으로 오인하지 않는다.
- 첫 부족 구간, 회복 전날·일수 또는 기간 말 미회복, 전 기간 최저 잔액과 날짜를 반환한다. 최저값 동률은 최초 날짜다. 시작 잔액 음수는 fork date부터 계산하며 원인은 `negative_start_balance`, 항목은 빈 배열이다. 첫 부족일 항목은 반복 규칙 ID → 예정 거래 ID 순서다.
- **T12:** `scenario_liquidity=true`, cash curve와 두 비교 대상의 shortage, basis cash revision을 제공한다. 미설정은 `available=false`와 이유만 반환한다. UI 기본은 순자산·6개월이며 현금 전환, 3/6/12개월, 미설정 링크, 일 마감 부족 설명을 지원한다. capability false fixture에서는 현금 전환을 숨긴다.

## 검증 범위

`backend/tests/test_scenario_liquidity.py`는 수동 golden·Hypothesis 이체 중립/순열·baseline 독립, 같은 날 여러 원인·회복·음수 시작·미회복·후속 최대 부족, 단일 이벤트 확장, 계정 쓰기 matrix·raw SQL 방어·표준 시드·stale version·revision·같은 SQLite read snapshot, migration 실패 rollback·재시도·기본값·백업 멱등을 검증한다. 기존 migration 2 전용 테스트는 runner를 migration 2까지로 고정하고, 전체 업그레이드 테스트는 migration 3을 포함한다.

`frontend/e2e/scenario-liquidity.spec.ts`는 실제 설정 저장과 취소·충돌 초안 보존·미설정, 실제 API 예정 이체의 현금 부족, true/false capability, 골든 원인 목록·음수 시작·미회복·503 재시도, 720px·키보드·axe를 검증한다. 기존 E2E는 조회 취소·지연 응답·3/6/12개월·390px 설정 패널 회귀를 계속 검사한다.

## 성능

M2 Pro, macOS 26.5.1, Python 3.13.3, SQLite 3.47.1. 승인 기준 runtime(Python 3.14.6 / SQLite 3.51.0)과는 다르며, 동일 장비·동일 runtime에서의 base/head 비교로 검증했다. 동일 장비에서 별도 main checkout과 작업본을 순서대로 측정했다. 양쪽에 같은 benchmark script를 적용하며 작업본은 실제 계정을 현금성으로 선택해 cash payload를 포함한다.

```sh
cd backend
uv run python tests/benchmark_projection.py --warmups 5 --samples 30 --months 12 --enforce-reference --output /tmp/projection-pr4-head.json
python3 ../scripts/compare-projection-benchmarks.py /tmp/projection-pr4-base.json /tmp/projection-pr4-head.json
```

250계정 / 50,000 actual 거래 / 200 actual 규칙 / 100 시나리오 규칙 / 500 예정 거래 / 12개월 fixture다.

| 지표 | main | PR4 | 기준 |
| --- | ---: | ---: | --- |
| 서비스 p95 | 177.6ms | 199.0ms (+12.0%) | ≤300ms, 회귀 ≤25% |
| API p95 | 165.7ms | 192.0ms (+15.9%) | ≤500ms, 회귀 ≤25% |
| 서비스/API SQL | 9 / 9 | 9 / 9 | 각각 ≤18 |

기존 PR CI workflow가 동일 runner의 base/head 측정과 비교 스크립트를 실행한다. 비교 스크립트와 benchmark의 PR4 SQL 상한은 18이며 시간 회귀 상한 25%를 유지한다. 원격 CI 결과는 아직 없으며 ship 후 PR에서 확인한다. 캐시나 materialized table은 추가하지 않았다.

## 전체 검증 결과

- Backend: `cd backend && uv run pytest -q` — 335 passed, 기존 Starlette deprecation warning 1개.
- Frontend: `cd frontend && npm run build` — 통과.
- E2E: `MONEYMAP_E2E_BACKEND_PORT=8882 MONEYMAP_E2E_FRONTEND_PORT=5280 npm run e2e` — 전체 51 passed (52.7s). 임시 DB만 사용하며 실제 API 테스트가 만든 개시잔액 거래는 `finally`에서 정리한다.
- 변경 backend 파일 Ruff check와 `git diff --check` — 통과.

기존 transaction-input 설계·이미지·frontend `.vite` 등 사용자 작업은 보존했다. 릴리스 버전은 0.5.0.0이다.

## Ship 리뷰

같은 Codex 계열 재사용 에이전트로 coverage·계획 완료·backend/API/security/migration/performance·frontend/design·maintainability/simplification/red-team·adversarial 검토를 수행했다. 외부 모델 또는 새 컨텍스트 리뷰는 아니다. 최대 부족 금액을 우측 정렬·tabular numerals로 표시하도록 수정하고 E2E 계산 스타일 검증을 추가했다. 그룹 포함 개수와 그룹의 현금 체크박스 비노출도 검증한다. `test_cash_ship_coverage.py`는 최저 잔액 동률의 최초 날짜와 cash revision 변경 직후 실패 시 전체 rollback·재시도를 검증한다. 재검토에서 미해결 production finding은 없다.

Ship coverage 감사: 28/30 행동 그룹(93%, 계측 coverage가 아님), 남은 2개는 unknown/missing capability와 빈 항목명 fallback이다. Backend 335 passed, E2E 51 passed, build 통과.
