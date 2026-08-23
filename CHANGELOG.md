# Changelog

All notable changes to MoneyMap are documented in this file.

## [Unreleased] - 2026-08-23

### Added
- Move an existing account to another active group of the same type without changing its ID, transactions, recurring-rule references, opening balance, or raw balance.
- Edit an account's name, parent group, and overdraft state through one atomic, optimistic-concurrency-protected settings request.
- Preserve account drafts on duplicate-name and stale-version errors, restore focus after successful saves, and expose only restore for archived accounts.
- Configure Playwright frontend/backend ports and the frontend API base with `MONEYMAP_E2E_FRONTEND_PORT`, `MONEYMAP_E2E_BACKEND_PORT`, and `MONEYMAP_E2E_API_BASE`.

### Changed
- Persist sibling display order with `accounts.position`; new and moved accounts now appear last in their target sibling group and keep that order across rename, archive/restore, restart, and standard reseeding.
- Backfill legacy sibling positions by account creation ID. Existing accounts may therefore change once from alphabetical display order to historical creation order on upgrade.
- Run the shared-database Playwright suite with one worker and a port-scoped temporary database.

### Fixed
- Prevent a recurring-rule-backed leaf account from being converted into a group, keeping the canonical `placeholder OR has children` non-postable invariant across current tree mutation paths.

## [0.1.0.0] - 2026-08-17

### Added
- Mark an eligible asset account as a reversible overdraft account without moving it or changing its stored account type.
- Record a deposit or overdraft-used opening balance with an explicit state, and undo the opening transaction from the account row.
- See an overdraft account reported as `부채 · 마이너스 사용 중` on the Dashboard only while its balance is negative.

### Changed
- Edit account names and overdraft settings in the existing hierarchical account ledger while keeping transaction and rule references intact.
- Load account balances and opening-balance status independently so a partial read failure does not disable unrelated account work.
- Keep the Accounts ledger contained at 1024px and stack Dashboard tables below 1200px.

### Fixed
- Prevent overdraft accounts from becoming groups or gaining child accounts, including writes that bypass the API and reach SQLite directly.
- Prevent duplicate opening balances by recognizing only the exact balanced two-posting structure that uses the named system opening account.
- Prevent recurring rules from using system accounts, and preserve legacy rules until their already-generated transactions are removed.
