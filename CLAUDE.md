# MoneyMap

복식부기 개인 가계부 + What-if 미래 자산 시뮬레이터. 로컬 단일 사용자, FastAPI+SQLite+Pydantic 백엔드(`backend/`, 헥사고날) + React+TypeScript 프론트(`frontend/`).

- 프로젝트 지침·테스트: [AGENTS.md](AGENTS.md)
- 설계서(source of truth): [DESIGN.md](DESIGN.md)
- 릴리스 변경: [CHANGELOG.md](CHANGELOG.md), 후속 작업: [TODOS.md](TODOS.md)
- 계정 설정·이동 설계: [account-reparenting.md](docs/designs/account-reparenting.md)
- 계정 형제 순서 변경·드래그·실행 취소: [account-ordering.md](docs/designs/account-ordering.md), [구현 검증](docs/verification/account-ordering.md)
- 대시보드 계정 잔액(v0.8.2.0): 보관 계정은 잔액과 무관하게 목록에서 숨기고, 복원 후 다시 표시한다. 계정 상태 확인 전·조회 실패에는 확인되지 않은 행을 표시하지 않는다. 과거 거래와 전체 순자산 계산은 유지하므로 목록 행의 합계와 ‘전체 순자산 (보관 계정 포함)’은 다를 수 있다. [목록·복원·조회 복구 회귀 테스트](frontend/e2e/dashboard-balances.spec.ts).
- 과거 CSV 이관·거래 태그: [이관 설계](docs/designs/legacy-transaction-migration-and-tags.md), [이관 CLI](backend/scripts/import_legacy_csv.py), [로컬 메모 교정 설정](docs/verification/legacy-local-corrections.md)
- 시나리오 승인 설계(PR 1~4): [scenario-lifecycle.md](docs/designs/scenario-lifecycle.md)
- v0.2.0.0 구현 범위·검증·저장소 운영 계약: [scenario-foundation.md](docs/verification/scenario-foundation.md). PR1(T1~T4)은 릴리스되었다. PR2(T5~T7)의 live-additive 전망·수명주기·legacy 전환·라우팅 구현과 검증은 [scenario-lifecycle.md](docs/verification/scenario-lifecycle.md)를 참고한다. PR3(T8~T9)의 복제·예정 거래 CRUD 구현과 검증은 [scenario-assumptions.md](docs/verification/scenario-assumptions.md)를 참고한다. PR4(T10~T12)의 현금성 계정 설정·현금 전망·부족 진단 구현과 검증은 [scenario-liquidity.md](docs/verification/scenario-liquidity.md)를 참고한다.
- 거래 입력·마지막 계정 조합·메모: [transaction-input.md](docs/designs/transaction-input.md), [구현 검증](docs/verification/transaction-input.md)
- v0.8.1.0 신규 입력 계정 재적용: [현재 정책](docs/designs/transaction-input-recall-refresh.md), [QA 테스트 계획](docs/verification/transaction-input-recall-refresh-test-plan.md), [실행 결과·남은 검증 범위](docs/verification/transaction-input-recall-refresh-results.md). 새 아이템의 유효 추천은 자동/유지 계정을 갱신하고 직접 선택한 쪽은 보호한다. 조회는 5초 후 종료하며 실패·실행취소 뒤에는 ‘계정 추천 다시 조회’로 다시 요청할 수 있다.
- 거래 직접 수정·충돌/응답 유실 보호·신규 입력 계정 유지: [transaction-editing.md](docs/designs/transaction-editing.md), [구현 검증](docs/verification/transaction-editing.md). 개발서버 자동 재시작으로 v6 스키마가 적용됐고 기존 거래 값은 보존됐다. 통화·태그 선택 UI·계정 시간 이력은 TODO로 유지한다.
- 진행 상태: 로컬 `WORKING.md`가 있을 때 참고

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
