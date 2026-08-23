# Changelog

All notable changes to MoneyMap are documented in this file.

## [Unreleased]

## [0.1.0.0] - 2026-08-23

### Added
- Rename accounts and mark eligible asset accounts as reversible overdraft accounts without breaking existing transactions or recurring rules.
- Record deposit or overdraft-used opening balances explicitly, undo them from the account row, and report active overdraft usage as `부채 · 마이너스 사용 중` on the Dashboard.
- Move an existing account to another active group of the same type without changing its ID, transactions, recurring-rule references, opening balance, or raw balance.
- Edit an account's name, parent group, and overdraft state through one atomic, optimistic-concurrency-protected settings request.
- Preserve account drafts on duplicate-name and stale-version errors, restore focus after successful saves, and expose only restore for archived accounts.
- Start a transaction directly from an empty History view instead of leaving the screen without a next action.
- Configure Playwright frontend/backend ports and the frontend API base with `MONEYMAP_E2E_FRONTEND_PORT`, `MONEYMAP_E2E_BACKEND_PORT`, and `MONEYMAP_E2E_API_BASE`.

### Changed
- Persist sibling display order with `accounts.position`; new and moved accounts now appear last in their target sibling group and keep that order across rename, archive/restore, restart, and standard reseeding.
- Backfill legacy sibling positions by account creation ID. Existing accounts may therefore change once from alphabetical display order to historical creation order on upgrade.
- Load account balances and opening-balance status independently so one failed read does not disable unrelated account work, and keep existing rows visible with a retry action when a refresh fails.
- Make the account ledger and dashboard responsive, raise small-text contrast to WCAG AA, restore heading and form-label hierarchy, enlarge mobile touch targets, and present reversible archive actions with neutral styling.
- Run the shared-database Playwright suite with one worker and a port-scoped temporary database.
- Keep project guidance, design decisions, and test commands usable from a clean checkout without depending on ignored local memory files.

### Fixed
- Prevent overdraft accounts from becoming groups or gaining children, including writes that reach SQLite without using the API.
- Recognize opening balances only when they have the exact balanced two-posting structure and use the named system opening account.
- Prevent recurring rules from using system accounts while preserving legacy rules until their generated transactions are removed.
- Prevent a recurring-rule-backed leaf account from being converted into a group, keeping the canonical `placeholder OR has children` non-postable invariant across current tree mutation paths.
- Wait for dashboard data before checking responsive layout so the E2E suite does not measure the transient onboarding state.
