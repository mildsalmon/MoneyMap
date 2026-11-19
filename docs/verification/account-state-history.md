# Account state history verification

The [approved §4 design](../designs/backlog-office-hours-2026-11-19.md) covers transaction selection and existing posting references. The synthetic ledger contains a bank, an expense account, a child under an implicit group, an explicit destination group, and a balanced transaction from May 1. Migration runs on a v11 file with the SQLite clock fixed at May 15, 2020. Subsequent requests use real application clocks and independent SQLite connections.

| Criterion | Check and expected observation |
| --- | --- |
| Atomic baseline and upgrade | Fail after v12 captures its baseline. A second connection sees schema v11, the two original postings and no event table. Retry captures six accounts once. Restart writes zero rows. The migration backup opens as v11. |
| Effective date and day close | An archive recorded later takes effect at May 31 15:00 UTC, midnight June 1 in Seoul. May 31 can post. June 1–4 reject new postings. A June 5 restoration permits posting that day. |
| Same-time order and retroactive correction | Retime the archive to June 3 and recheck both sides of the new boundary. Retime it to the restoration instant and the higher original event sequence wins. The original event and both correction receipts survive. Stale corrections and impossible orders roll back. |
| Creation, reparenting and parent eligibility | A new child turns a postable leaf into a group on its effective day. Moving the last child updates its parent link and the former parent's explicit group flag in one action. Correcting the move shifts both events together. Releasing the former group permits posting from the release date. |
| Failure and retry | Abort the former parent's group event after the child move. An independent reader sees the original parent, name, versions and event count. Retrying after removing the fault records one move and one group change. |
| Unknown history and retained references | Before May 15, new selections follow current eligibility. A manual edit retaining original posting IDs 41 and 42 succeeds even while the bank is archived. Attempting to select that bank on a new row during its archive period fails. |
| Real UI and server agreement | Chromium uses a private FastAPI process and a migrated SQLite file. The account screen sets both effective dates. Changing the transaction date removes or restores the bank radio and disables or enables Save. A real POST succeeds on June 5. A UI correction restores June 1 availability and an edit preserves both original posting IDs. |

The UI shows half-open eligibility periods. Each period includes its start and ends immediately before the next start. Reads fold same-time changes by their original sequence, apply the latest date correction to the entire action, and coalesce adjacent equal states. A backdated change therefore affects reads from the earliest changed boundary, including both parents of a move. The ledger stores the journal and derives periods on read.

The backend regression suite is in [test_account_state_history.py](../../backend/tests/test_account_state_history.py). The browser check is in [account-state-history.spec.ts](../../frontend/e2e/account-state-history.spec.ts). The PR verification record identifies the tested commit, commands, isolated ports, and results.
