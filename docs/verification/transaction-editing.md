# Transaction editing — implementation verification

Date: 2026-09-12
Status: implementation verified; v0.7.0.0 branch committed and pushed on 2026-09-13; merge and release deployment pending.

Review follow-up (2026-09-13): all eight confirmed findings were fixed with regression coverage. Final backend **458 passed**, frontend **139 passed**, build and diff check passed. See [review fixes and evidence](transaction-editing-review.md) and [private import correction setup](legacy-local-corrections.md). No additional schema migration or real transaction edit/reimport was performed.

Ship verification (2026-09-13): backend **478 passed**, frontend **139 passed**, and frontend build passed after adding 20 synthetic import guard, rollback and backup checks. Tag checkbox sizing and wrapping were also corrected in both transaction forms. These results supersede the earlier run totals below; the earlier dated verification remains a historical record. No private CSV or live ledger was used for ship QA.

## Delivered behavior

- History opens `/transactions/:id/edit` with a one-item fetch. Edit date, description, amount, accounts, multiline memo, tags and split rows without deleting/recreating the transaction.
- Direct entries, imported records, generated recurring occurrences and opening balances use the same editing flow. Transaction identity, retained posting identity and import provenance stay intact. Editing an occurrence does not change its rule, watermark or other occurrences.
- A retained posting may keep its historical archived/group account. The exception is bound to its original posting ID and account; new/replaced references must be usable now. Original zero rows can remain zero or be corrected; new zero rows and nonzero-to-zero changes are rejected.
- Opening balances retain their protected two-row shape. The server fixes the system counterpart, checks target/sign and checks duplicate openings under the same write lock.
- The shared create/edit form keeps selected accounts when the item changes. Creation recall fills empty sides only, including after a failed/empty suggestion. Editing never requests recall. New-entry saves still clear amount, memo and tags.
- Stale saves never overwrite another edit. Failure/conflict keeps the draft; loading current values requires an explicit action and preserves a summary of the previous draft. Saving/unknown-result phases lock editing and duplicate submission.
- Lost/malformed save responses use result confirmation, not another PUT. An applied request is idempotent. A resolver that gets the write lock first seals `not_applied`, preventing the delayed original request from applying. Unknown results stay locked with a retry-confirmation action.
- Cancel/navigation warns for unsaved changes; beforeunload also protects reload/close. Filter, list scroll and row focus are restored; a tag change that removes a transaction from the filter is explained as a successful save.

## Database and rollout

- Schema migration 6 adds `transactions.edit_version` and `transaction_edit_requests`. Opaque revision tokens also protect against SQLite numeric transaction-ID reuse.
- SQL triggers invalidate revisions for transaction, posting and tag-link changes, including existing account reclassification and rule-deletion writers. Account display-only changes do not invalidate transactions.
- GET uses the existing request read snapshot. Update/result confirmation uses `BEGIN IMMEDIATE`, bounded reads/validation, atomic fields/postings/tags/version/receipt changes and rollback on failure. Single-detail fetching executes three queries and uses the posting index.
- Receipts contain request ID, transaction ID, expected version, canonical payload hash, terminal outcome and result version. They contain no before/after copies and intentionally survive transaction deletion.
- Existing startup migration takes a verified backup before upgrading an old ledger. Tests cover v5→v6, repeated startup and injected migration failure/rollback. The already-running development server used `uvicorn --reload`, so source changes automatically restarted it and applied migration 6 to the real local ledger. No explicit real-ledger edit/import request was sent. The user's CSV was not used for tests.

### Actual local ledger verification after automatic reload

The automatic reload was discovered during final runtime inspection, correcting the earlier assumption that the real ledger had not been upgraded. Read-only comparison against its migration backup confirmed:

| Existing data | Current / backup rows | Differences in either direction |
|---|---|---|
| Transactions, all original columns | 7,797 / 7,797 | 0 |
| Postings | 15,594 / 15,594 | 0 |
| Transaction tag links / tag definitions | 664 / 664; 12 / 12 | 0 |
| CSV provenance | 7,677 / 7,677 | 0 |
| Accounts / recurring rules / scenarios | 181 / 181; 1 / 1; 1 / 1 | 0 |

`PRAGMA user_version` is 6, `quick_check` returns `ok`, all transactions have edit revisions, and the real request-receipt table has **0 rows**. Existing transaction values were not edited. The comparisons used both-direction `EXCEPT` queries over original columns and printed only counts.

Backup: `backend/backups/migration-v5-to-v6-08910dffe0c54118ad59e4fdc324f5a1.db`. SHA-256 matched its manifest: `4ce173938d782e0fe951a28a05859f75e12c7158d6f34cc85787266f32ca2889`. No WAL file was present for the immutable read-only comparison; the database was not opened through application startup for this verification.

## Verification

- Backend: `cd backend && uv run pytest -q` — **434 passed**, including 36 new edit/migration cases.
- Frontend: `cd frontend && MONEYMAP_E2E_BACKEND_PORT=8967 MONEYMAP_E2E_FRONTEND_PORT=5375 npm run e2e` — **133 passed**, including 29 new edit-state/browser cases.
- Build: `cd frontend && npm run build` — passed; Vite reports its chunk-size warning.
- `git diff --check` — passed. Backend retains the existing Starlette/httpx deprecation warning.
- All browser writes use the Playwright-created `/tmp/moneymap-e2e-8967` ledger. External API override was unset, and the already-running app on port 8765 was not reused or stopped.
- Test files: `backend/tests/test_transaction_edit.py`, `test_transaction_edit_migration.py`; `frontend/e2e/transaction-edit-state.spec.ts`, `transaction-edit.spec.ts`, and the existing input, router, account and scenario suites.

## Requirement coverage

The design's 30 groups are requirements, not an assertion of exhaustive branch coverage or 30 test functions.

Ship audit limitation: the detail-query test establishes three queries and posting-index use for one fixture; it does not compare increasing dataset sizes or verify every planned index. The account-ordering test limitations are recorded in [its verification report](account-ordering.md).

| Groups | Evidence |
|---|---|
| B01–B02/B08 | Full-field real API edits, retained/new/deleted posting IDs, basic/split round trips and validation |
| B03–B05 | Historical account/row identity, zero preservation, opening structure/sign/duplicate checks and concurrent moves |
| B06–B07 | Synthetic CSV import→edit→reimport preserves provenance/dedup; generated occurrence edit preserves rule/watermark and materialize returns zero duplicates |
| F01–F03 | Shared state/form tests, no recall on edit, preserved choices after item/lookup changes, new-entry clearing and late-response regressions |
| F04–F06 | Filter/scroll/focus return, hidden-by-filter notice, cancel/Back, beforeunload, IME/multiline memo, 390px Chromium and axe |
| E01–E04/E02a | Invalid payload rollback, stale/deleted/other-writer versions, unavailable account rules, injected tag failure and concurrent SQLite connections |
| E05–E07/E14–E15 | Real applied-response loss/malformed response, resolver-before-save fence, repeat request/mismatch, unknown-state retry lock, late completion after exit, numeric ID reuse |
| E08–E10 | Foreign-currency save rejection, query/lookup/list refresh failures without draft loss, upgrade/restart/backup/rollback |
| E11–E13 | Old/new account balances, actual/scenario projection date boundaries and ledger revision, existing router regressions, bounded single-detail query count/index |

## Debug report (gstack-investigate)

- **Symptom:** new browser tests timed out selecting a split account, collided while answering navigation dialogs, or inconsistently missed a query-error retry button.
- **Root cause:** `.check()` tried to verify a radio after the picker had unmounted; the next dialog listener was registered before the previous confirm had finished; a request-count-based failure stub was consumed by StrictMode cancellation and startup refresh.
- **Fix:** click the transient radio and assert the selected account on its persistent button; explicitly await each dialog response; use test-controlled failure states instead of assuming a fixed number of requests.
- **Regression:** `frontend/e2e/transaction-edit.spec.ts`. Both original interaction failures passed targeted reruns; the query-error case passed five consecutive runs. Full-suite result is recorded above.
- **Related:** prior account-settings tests already required waiting for asynchronous mutations before asserting persistence. These changes repair test synchronization, not ledger semantics.
- **Status:** DONE. Full backend and browser suites passed. The temporary investigation edit boundary was cleared; no tool upgrade or automatic commit was performed.

## Boundaries

- KRW editing only. Foreign transactions remain protected/read-only; no conversion or reclassification of historical USD purchases.
- Tag-selector redesign, account action history/SCD Type 2 and multi-currency work remain in TODOS.md. Edit history/undo, bulk editing and full-list pagination are not added.
- Browser automation uses Chromium, not physical mobile devices or separate Safari/Firefox verification. The shared form's existing tag UI remains; it was not redesigned.
- During the 2026-09-12 implementation verification, no real transaction edit/import request, commit, push, release deployment, new dependency installation or gstack upgrade was performed. The later ship run committed and pushed the release branch; merge and deployment remain separate. The local schema upgrade caused by the existing auto-reload server is documented above; it must not be confused with an unchanged database schema.
