# Scenario assumptions — PR3 검증 기록

- 기준 설계: [scenario-lifecycle.md](../designs/scenario-lifecycle.md)의 승인된 T8/T9.
- 기반: PR2가 머지된 `origin/main`의 `d791f42`, 작업 브랜치 `codex/scenario-assumptions`.
- 상태: 기능 커밋 `49d2f2b`(backend), `d1c9e36`(frontend). ship 검증과 v0.4.0.0 MINOR 승인을 완료했다. v0.4.0.0 릴리스 커밋 `e12ef68`과 테스트 동기화 수정 `37321d9`를 푸시하고 [PR #5](https://github.com/mildsalmon/MoneyMap/pull/5)를 게시했다. 원격 CI 최종 결과는 별도로 확인한다.

## 구현

| 작업 | 동작 |
| --- | --- |
| T8 복제 | 정보 탭에서 이름·설명·시작 기준일을 정한다. UoW 안에서 원본 active/live 상태와 version을 확인하고 소유 규칙·수동 예정 거래만 새 ID로 복사한다. 실제 규칙·generated 거래는 복사하지 않는다. 규칙 날짜는 유지하고 materialization 상태를 초기화한다. 성공 시 복사 건수를 반환하며 원본 version은 유지한다. |
| T9 예정 거래 | 가정 탭의 목록·추가·수정·삭제. 여러 분개를 보존하고 수정 시 거래 ID는 유지한다. 같은 transaction 안에서 unpost→postings 교체→repost한다. 성공한 명령마다 aggregate version을 정확히 한 번 증가시킨다. |

복제 기준일과 같거나 이전인 예정 거래가 있으면 `409 scenario_duplicate_date_conflict`에 충돌 거래 전체를 반환한다. 새 시나리오를 남기지 않는다. 예정 거래는 path 소유권, active/live 상태, 제출 version, 날짜·균형·계정 적격성을 검증한다. 삭제는 strong `If-Match`를 요구한다. 요청 body에 소유자나 source rule을 주입할 수 없다.

현재 전망은 원화 기준이므로 예정 거래 생성·수정은 원화 계정과 KRW postings만 허용한다. 외화는 `400 scenario_currency_unsupported`로 거부하여 환산 없이 원화 전망에 합산되는 것을 막는다. 혼합 통화·불균형·0원 분개도 거부한다. 기간 밖 예정 거래는 보존하고 현재 전망에서만 제외한다.

버전 충돌은 초안을 유지하며 최신 버전 확인 후 사용자가 다시 제출한다. 자동 재제출하지 않는다. 쓰기 중 입력과 편집 전환을 잠그고, 정보 탭의 복제·정보 저장·보관은 pending 상태를 공유한다. 화면 이탈 후 완료된 mutation은 이동이나 재조회를 시작하지 않는다. 목록 GET은 기존 `useQuery`의 AbortSignal 경로를 사용한다.

## 검증 범위

- `backend/tests/test_scenario_assumptions.py`: 복사 건수·새 ID·원본 불변, actual/generated/다른 소유자 배제, 날짜 충돌 payload와 zero-write, CRUD·분개 전체 교체·posted 상태·version exactly-once, 오래된 요청 중복 방지, strong ETag 400/412/428, 보관·legacy 상태 우선 검사, 외화 차단, 1 JOIN 목록 조회.
- 복제·생성·수정·삭제의 16개 쓰기 경계에 SQLite 실패를 주입한다. scenario/rules/transactions/postings/revisions 전체 snapshot이 actual·다른 시나리오까지 복원되는지 확인하고 같은 요청의 정상 재시도도 검증한다.
- 동시 예정 거래 명령은 같은 version에서 단일 승자만 허용한다. 전망의 수동 계산 결과 100→200→기간 밖 0→삭제 0을 확인해 중복 합산과 오래된 결과를 방지한다. 기존 3·6·12개월 golden/Hypothesis 검증도 유지한다.
- `frontend/e2e/scenario-assumptions.spec.ts`: 생성·다중 분개 수정·복제·삭제·보관 읽기 전용, 복제 날짜·version 충돌, 불균형 오류·version 초안 복구, GET 실패·삭제 ETag 복구, 지연 POST/PUT/duplicate의 입력 잠금과 화면 이탈, 키보드·포커스·720px·axe.
- 기존 lifecycle E2E의 규칙 표 선택자를 좁혀 예정 거래 표 추가 후에도 원래 검증 의도를 유지한다.

## 실행 결과

| 명령 | 결과 |
| --- | --- |
| `cd backend && uv run pytest -q` | 304 passed (10.48s), 기존 Starlette deprecation warning 1개 |
| 변경 backend 파일 `uv run ruff check` | 통과 |
| `cd frontend && npm run build` | 통과, Vite 6.4.3 (2.07s) |
| `cd frontend && MONEYMAP_E2E_BACKEND_PORT=8882 MONEYMAP_E2E_FRONTEND_PORT=5280 npm run e2e` | 47 passed (52.5s) |
| `git diff --check` | 통과 |

`gstack-review`의 검토 항목을 슬롯 제약에 맞춰 두 에이전트에 묶어 배정하고 추가 adversarial 검토를 실행했다. 재사용한 같은 Codex 계열 컨텍스트이며 외부 모델 검증은 아니다. 통화 검증, 복제 pending 상태 공유, 숫자 정렬의 3건을 수정하고 재검토했다. 미해결 코드 finding은 없다. 승인 T8/T9 구현·검증 항목을 충족했으며 설계 원문은 보존했다.

E2E는 포트 8882/5280, `/tmp/moneymap-e2e-8882`의 임시 DB를 사용했다. 실제 사용자 DB와 기존 transaction-input 문서·이미지 작업은 보존했다. 별도 migration은 필요하지 않으며 PR4 현금성 기능은 이번 구현에 포함하지 않는다.

## Ship 재검증

- 최종 Backend: 304 passed (10.48s), frontend build: 통과 (2.07s).
- E2E: 47 passed (52.5s). 지연 응답 검증은 고정 sleep 대신 requestfinished와 렌더 완료를 기다린다.
- 승인 PR3 T8/T9 계획 완료 2/2, 새 production finding 없음. 테스트 동기화 finding 1건을 수정하고 재검토했다.
- 별도 지속 실행 dev server는 발견되지 않아 ship의 qa-only 자동 실행은 건너뛰었다. 브라우저 검증은 위 격리 E2E에 기록했다.

PR CI 실행 `33942396479`에서 지연 복제 테스트가 URL 변경만 확인한 뒤 응답을 해제해 실패했다. trace에서 목적지 화면의 React 반영 전임을 확인했고, 목적지 제목의 포커스와 원본 편집기 제거를 기다린 뒤 응답을 해제하도록 테스트를 수정했다(`37321d9`). production 코드는 변경하지 않았으며 위 결과는 수정 후 전체 로컬 재검증이다.
