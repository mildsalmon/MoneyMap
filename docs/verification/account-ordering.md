# Account ordering — implementation verification

Date: 2026-09-12

## Delivered behavior

- Desktop: drag the dedicated handle within the same sibling group. A group moves with its displayed descendants; its hierarchy does not change.
- Click the handle, or press Enter/Space, to open up/down controls. Escape closes the panel. Mobile/coarse-pointer layouts show 44px buttons below the account name.
- Changes save immediately. Only the latest confirmed save offers undo; stale undo never overwrites a newer account edit.
- All account mutations are locked during saves and recovery. Failed confirmation leaves a persistent retry action; dispatched writes may finish after navigation without updating the departed screen.
- Account settings, transaction trees, regular rules and scenario rules use shared persisted positions. Normal reorder/undo does not trigger global financial-data refreshes.
- Existing `accounts.position` and `version` are used; no schema migration or live-ledger rewrite is needed. Transactions, postings, balances, parent relationships, archived slots and system slots remain unchanged.

## Verification

- Backend: `cd backend && uv run pytest -q` — 398 passed.
- Frontend build: `cd frontend && npm run build` — passed.
- Frontend suite: `cd frontend && MONEYMAP_E2E_BACKEND_PORT=18765 MONEYMAP_E2E_FRONTEND_PORT=15173 npm run e2e` — 104 passed (isolated temporary database).
- `git diff --check` — passed.
- New backend tests cover snapshot validation, stale versions, preserved slots, no-op, undo, subtree/financial invariants, overflow and transactional rollback.
- New frontend tests cover pure ordering/response validation, drag/subtree movement, invalid cross-parent drop, buttons, keyboard, mobile focus, reload, shared rule ordering, stale undo, recovery/retry, ambiguous responses, navigation and toast/request lifetimes.
- Desktop/mobile screenshots were inspected against the approved simple ledger layout. A drag-overlay document-height regression was found and fixed; the drag test now asserts the target row does not shift on drag start.

## Boundaries

- This is sibling ordering, not reparenting or per-screen preferences.
- Browser automation runs Chromium; other browsers and physical touch devices were not separately tested.
- Existing npm audit findings in unrelated toolchain dependencies were not changed in this feature.
