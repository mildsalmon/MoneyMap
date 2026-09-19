# Changelog

All notable changes to MoneyMap are documented in this file.

## [Unreleased]

### Added
- Query transaction history by inclusive dates and tag, defaulting to the recent calendar month. Use recent-month, this-month and last-month shortcuts, with 100-row previous/next pages and shareable query URLs.

### Changed
- Preserve applied dates, tag, page, unsubmitted filter inputs and the actual scroll position when returning from a transaction edit.
- Fetch only the requested history page and its postings/tags within one read snapshot. Keep the existing full-list API and all ledger transaction kinds unchanged; no schema migration is required.

### Fixed
- Keep old results hidden during a new query or query failure, and let tag choices retry independently without resetting the query.
- Prevent duplicate deletion requests and offer read-only refresh when a deletion response is uncertain. Move to the last valid page when deletion removes the final page.

## [0.7.0.0] - 2026-09-13

### Added
- Edit a transaction in place from history, including imported transactions, generated rule occurrences, opening balances, split postings, multiline memos and tags. Preserve transaction/posting identity and original import provenance.
- Detect stale transaction edits and resolve uncertain saves without replaying the write. Keep drafts on failure, protect unsaved navigation, and restore the history tag filter, scroll and focus.
- Reorder sibling accounts with desktop drag handles or accessible up/down buttons, with immediate saving and a latest-change undo. The saved order is shared by account trees and rule account pickers.
- Recover uncertain account-order saves from the server and keep a persistent retry action when confirmation is unavailable, without changing transactions or balances.
- Attach several reusable tags to a transaction, select existing tags during entry, and display or filter them in transaction history.
- Import the reviewed legacy CSV one source row at a time with source-file fingerprinting, row-level provenance, dry-run reconciliation, and duplicate prevention.
- Add the approved detailed expense hierarchy, including rental-car costs, housing, travel, health, clothing, personal care, education, digital tools, taxes, insurance, and financial costs.

### Changed
- Share the transaction form between creation and editing. Changing an item or receiving an unavailable/failed account suggestion no longer clears selected accounts; suggestions fill empty sides only. Editing never invokes account recall.
- Keep zero-valued legacy opening-balance placeholders readable without allowing new zero-valued transaction input.
- Preserve refunds and settlements as independent source transactions instead of inferring or merging relationships during import.
- Restore `OK저축은행` as an everyday bank account, keep `한마을아파트` as an independent top-level asset, and group `갚을돈` under personal debt during legacy import.
- Keep legacy USD purchases in their original expense account until the ledger can preserve both foreign-currency units and their KRW valuation.
- Remove the unused `외화 > USD` leaf account from the standard account seed while multi-currency support remains deferred.

### Migration
- Schema version 6 adds opaque transaction edit revisions, writer-invalidation triggers and minimal request-result receipts. Existing ledgers use the backup/rollback upgrade path at startup; no historical transaction amounts or import provenance are rewritten by this migration.
- Backed up the empty pre-import ledger and imported 7,677 transactions with 15,354 balanced postings from the reviewed CSV. The two Lotte cards remain separate accounts.

### Fixed
- Keep reusable tag checkboxes compact, with readable wrapping labels and mobile-sized click targets in both transaction forms.
- Verify malformed import inputs, classification precedence, complete rollback and restorable backups with isolated synthetic-data checks.
- Preserve edited split postings when reimporting the same CSV, including runs mixing existing and newly imported rows.
- Keep private memo corrections in ignored, source-hash-scoped local configuration instead of publishable source code. Existing ledger memos and raw import provenance are unchanged.
- Apply the transaction request-body limit to edit and result-confirmation endpoints; rejected saves retain an editable draft.
- Reject expense, income and equity targets when moving a legacy zero opening balance.
- Report account recall only for sides filled by the current lookup, restore the actual history scroll container, wrap long conflict memos on mobile, and ignore equivalent amount formatting in dirty checks and mode changes.

## [0.6.0.0] - 2026-09-05

### Added
- Select debit and credit accounts directly from searchable account trees. Recall only the last saved account pair for an item, preserving manual choices and leaving date, amount, and memo unchanged.
- Add optional multiline transaction memos, with text-only viewing in transaction history.
- Keep split entries in the same draft, block incomplete rows, and fill a debt repayment amount only on explicit request.

### Changed
- Replace transaction type tabs and account dropdowns with fixed debit/credit columns; stack them on mobile with a sticky selection summary and bottom save action.
- Migrate transaction provenance and normalized item keys with the existing backup/rollback workflow. Older ambiguous records require confirmation; rule-generated and opening-balance transactions are excluded from recall.
- Keep new edits when a save finishes late, share an identical pending save across screen re-entry, and clear amount and memo only when the submitted draft is unchanged.
- Create opening balances only through the dedicated account action while continuing to recognize existing opening-balance records.

### Fixed
- Keep save confirmation and undo visible above the mobile save bar, including very long item names in basic and split entries.
- Distinguish identically named accounts with their full paths in older-record confirmation and split entries, and keep memo text consistent with the rest of the form.
- Preserve explicit account choices during delayed lookups, clear stale automatic choices after lookup failures, and retain actionable feedback when undo fails.
- Reject system-account postings, boolean amounts, unsafe totals, excessive split rows, and oversized descriptions, memos, or transaction requests before they can reach the ledger.

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
