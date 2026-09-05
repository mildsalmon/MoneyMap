# MoneyMap

복식부기 개인 가계부 + What-if 미래 자산 시뮬레이터. 로컬 단일 사용자, FastAPI+SQLite+Pydantic 백엔드(`backend/`, 헥사고날) + React+TypeScript 프론트(`frontend/`).

- 프로젝트 지침·테스트: [AGENTS.md](AGENTS.md)
- 설계서(source of truth): [DESIGN.md](DESIGN.md)
- 릴리스 변경: [CHANGELOG.md](CHANGELOG.md), 후속 작업: [TODOS.md](TODOS.md)
- 계정 설정·이동 설계: [account-reparenting.md](docs/designs/account-reparenting.md)
- 시나리오 승인 설계(PR 1~4): [scenario-lifecycle.md](docs/designs/scenario-lifecycle.md)
- v0.2.0.0 구현 범위·검증·저장소 운영 계약: [scenario-foundation.md](docs/verification/scenario-foundation.md). PR1(T1~T4)은 릴리스되었다. PR2(T5~T7)의 live-additive 전망·수명주기·legacy 전환·라우팅 구현과 검증은 [scenario-lifecycle.md](docs/verification/scenario-lifecycle.md)를 참고한다. PR3(T8~T9)의 복제·예정 거래 CRUD 구현과 검증은 [scenario-assumptions.md](docs/verification/scenario-assumptions.md)를 참고한다. 현금성 기능은 PR4 범위다.
- 진행 상태: 로컬 `WORKING.md`가 있을 때 참고

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
