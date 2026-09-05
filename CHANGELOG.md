# Changelog

All notable changes to MoneyMap are documented in this file.

## [0.6.0.0] - 2026-09-05

### Added
- Select debit and credit accounts directly from searchable account trees. Recall only the last saved account pair for an item, preserving manual choices and leaving date, amount, and memo unchanged.
- Add optional multiline transaction memos, with text-only viewing in transaction history.
- Keep split entries in the same draft, block incomplete rows, and fill a debt repayment amount only on explicit request.

### Changed
- Replace transaction type tabs and account dropdowns with fixed debit/credit columns; stack them on mobile with a sticky selection summary and bottom save action.
- Migrate transaction provenance and normalized item keys with the existing backup/rollback workflow. Older ambiguous records require confirmation; rule-generated and opening-balance transactions are excluded from recall.
- Keep new edits when a save finishes late, prevent duplicate pending submissions, and clear amount and memo only when the submitted draft is unchanged.

### Fixed
- Keep save confirmation and undo visible above the mobile save bar, including very long item names in basic and split entries.
- Distinguish identically named accounts with their full paths in older-record confirmation and split entries, and keep memo text consistent with the rest of the form.
- Preserve explicit account choices during delayed lookups, clear stale automatic choices after lookup failures, and retain actionable feedback when undo fails.

## [0.5.0.0] - 2026-09-05

### Added
- Choose which asset accounts count as immediately available cash from account settings.
- Switch scenario overviews between net worth and cash balance over 3, 6, or 12 months.
- Compare the first cash shortage, its duration and contributing items, and the largest shortfall for the baseline and scenario.

### Changed
- Keep existing and seeded accounts out of cash calculations until explicitly selected; show a settings link when no cash accounts are configured.
- Require deselecting a cash account before archiving it or turning it into a group, including by adding children.
- Back up existing ledgers before adding cash settings, and preserve cash selections during account renaming and moves.

## [0.4.0.0] - 2026-09-05

### Added
- Duplicate an active scenario with a new name, description, and start date, including its own recurring rules and planned transactions.
- Create, edit, and delete one-time planned transactions from the assumptions tab, including transactions with multiple postings.

### Changed
- Show every conflicting transaction when a duplicate's start date would exclude planned activity, so users can choose another date without losing data.
- Preserve planned transaction identities during edits and retain transactions outside the selected projection period.
- Keep drafts after conflicts, require an explicit retry with the latest version, and lock information controls while duplication is pending.

### Fixed
- Reject foreign-currency planned transactions and non-KRW accounts instead of treating their amounts as won in projections.
- Keep the current page when a planned transaction or duplication request finishes after navigation.

## [0.3.0.0] - 2026-09-05

### Added
- Create scenarios with names, descriptions, and dedicated overview, assumptions, and information pages; open them directly and navigate with browser history.
- Compare baseline and scenario net worth over 3, 6, or 12 months, with monthly income and expense bars and exact values in tables.
- Edit scenario-only recurring rules, archive and restore scenarios, and permanently delete archived scenarios after reviewing their affected records.
- Resolve older copied rules explicitly before switching an existing scenario to live assumptions, with recovery backups before migration.

### Changed
- New scenarios inherit the latest actual rules and add their own assumptions without copying rules. Archived scenarios remain read-only and recalculate from the latest actual ledger.
- Start projections from the actual ledger's closing balance on the selected date and project from the next day, using registered assumptions without inferred spending averages. Unconverted legacy scenarios retain their previous dashboard calculation.
- Use consistent read snapshots and batched queries for scenario projections; check query counts and release-to-release performance in CI.
- Cancel outdated screen queries and show explicit loading, failure, retry, and empty states while retaining editing drafts.

### Fixed
- Keep scenario mutations atomic and reject stale versions, cross-scenario writes, and stale deletion confirmations. Deleted scenario identities cannot be reused by a new scenario.
- Preserve keyboard focus and drafts after conflicts, require a second confirmation when deletion impact changes, and correctly distinguish dialog padding from its backdrop.
- Preserve the selected ledger date in chart tables across time zones and avoid reloading a scenario after successful deletion.
- Keep the current page and editing draft when a scenario creation or update finishes after navigating away, and prevent unsaved rule edits during a pending save.
- Avoid repeated transaction queries and spending calculations when comparing several unconverted legacy scenarios.

## [0.2.0.0] - 2026-09-05

### Added
- Create a verified recovery copy before upgrading an existing ledger, independently of daily backups. Upgrades stop before changing data when backup verification fails.
- Verify ledger upgrades, rollback, concurrent requests, and existing browser workflows in automated CI.

### Changed
- Keep ledger reads responsive while another request writes, with each balance or projection response reading one consistent snapshot.
- Return structured application errors with complete conflict and retry context while preserving standard request-validation responses.
- Separate account, transaction, rule, scenario, and reporting interfaces without changing the existing screens or copy-on-fork calculations.

### Fixed
- Roll back the entire scenario creation when copying any of its rules fails.
- Preserve automatic-generation progress when a recurring rule is edited concurrently, preventing duplicate generated transactions.
- Lock rules before automatic transaction planning so concurrent edits cannot post a stale plan.
- Roll back failed ledger schema changes together with their migration version, and apply each pending migration only once during simultaneous startup.

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
