# Changelog

All notable changes to MoneyMap are documented in this file.

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
