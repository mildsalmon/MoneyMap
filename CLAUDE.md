# MoneyMap

복식부기 개인 가계부 + What-if 미래 자산 시뮬레이터. 로컬 단일 사용자, FastAPI+SQLite+Pydantic 백엔드(`backend/`, 헥사고날) + React 프론트(예정).

- 설계서(source of truth): `~/.gstack/projects/MoneyMap/mildsalmon-master-design-20260705-090000.md`
- 진행 상태: `WORKING.md` · 테스트: `cd backend && uv run pytest`

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
