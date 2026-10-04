import type { TransactionDetail, TransactionEditBody, TransactionEditResult } from "../api";
import { isTransactionDetail } from "../api/transactionEditResponse";
import { amountInput, newDraft, type Draft, type OriginalRows, type validateDraft } from "./transactionInputState";
import { historyCriteriaError, type HistoryCriteria, type HistoryQuery } from "./historyQueryState";

export function originalRows(transaction: TransactionDetail): OriginalRows {
  return new Map(transaction.postings.map(p => [p.posting_id, p]));
}

export function editDraft(transaction: TransactionDetail): Draft {
  const draft = { ...newDraft(transaction.date), item: transaction.description, memo: transaction.memo, tags: [...transaction.tags] };
  const rows = transaction.postings.map((p, i) => ({ id: i + 1, postingId: p.posting_id, account: p.account_id,
    amount: amountInput(String(Math.abs(p.amount))), debit: p.amount === 0 ? i === 0 : p.amount > 0 }));
  const debit = rows.find(r => r.debit), credit = rows.find(r => !r.debit);
  if (rows.length === 2 && debit && credit && debit.account !== credit.account && debit.amount === credit.amount
      && (transaction.kind !== "regular" || debit.amount !== "0")) {
    return { ...draft, amount: debit.amount,
      debit: { account: debit.account, postingId: debit.postingId, source: "retained", revision: 0 },
      credit: { account: credit.account, postingId: credit.postingId, source: "retained", revision: 0 } };
  }
  return { ...draft, mode: "split", rows };
}

export function editBody(original: TransactionDetail, draft: Draft, validation: ReturnType<typeof validateDraft>, requestId: string): TransactionEditBody {
  if (!validation.valid) throw new Error("검산을 확인하세요");
  const base = { expected_version: original.version, request_id: requestId, date: draft.date,
    description: draft.item, memo: draft.memo, tags: [...draft.tags] };
  if (original.kind === "regular") return { ...base, postings: validation.postings };
  const target = validation.postings.find(p => p.account_id !== original.opening_system_id);
  if (!target) throw new Error("개시잔액 대상 계정을 선택하세요");
  return { ...base, opening: { account_id: target.account_id, signed_amount: target.amount } };
}

/** editing -> saving -> saved | conflict | uncertain -> resolving
 * resolving -> saved | conflict | editing (terminal not_applied) | uncertain
 * Neither an old GET nor a failed resolver grants permission to resend. */
export type EditPhase = "editing" | "saving" | "resolving" | "uncertain" | "conflict";

export function classifyEditResult(result: TransactionEditResult, transactionId: number, submitted: TransactionEditBody): "saved" | "retry" | "conflict" | "invalid" {
  if (result?.request_id !== submitted.request_id || !["applied", "not_applied"].includes(result?.outcome)) return "invalid";
  const current = result.transaction;
  if (current !== null && !isTransactionDetail(current, transactionId)) return "invalid";
  if (result.outcome === "applied") {
    if (!result.result_version || !/^[0-9a-f]{32}$/.test(result.result_version)) return "invalid";
    return current?.version === result.result_version ? "saved" : "conflict";
  }
  if (result.result_version !== null) return "invalid";
  return current?.version === submitted.expected_version ? "retry" : "conflict";
}

// UI revision/lookup epochs aren't user data. Editing a field back to its
// original value should not trigger a discard prompt.
export function draftIdentity(draft: Draft): string {
  return JSON.stringify([draft.date, draft.item, draft.memo, draft.tags, draft.mode,
    draft.mode === "basic" ? [amountInput(draft.amount), draft.debit.account, draft.debit.postingId, draft.credit.account, draft.credit.postingId]
      : draft.rows.map(r => [r.postingId, r.account, amountInput(r.amount), r.debit])]);
}

export interface HistoryReturn {
  tagFilter: string; scrollY: number; scrollLeft: number; focusId: number | null;
  query: HistoryQuery | null; draft: HistoryCriteria | null;
}
export function historyReturn(value: unknown): HistoryReturn {
  const candidate = value as Partial<HistoryReturn> | null;
  const raw = candidate?.query;
  const criteria = (v: unknown): HistoryCriteria | null => {
    const c = v as Partial<HistoryCriteria> | null;
    return typeof c?.start === "string" && c.start.length <= 10 && typeof c.end === "string" && c.end.length <= 10 && typeof c.tag === "string"
      ? { start: c.start, end: c.end, tag: c.tag } : null;
  };
  const valid = criteria(raw);
  return { tagFilter: typeof candidate?.tagFilter === "string" ? candidate.tagFilter : "",
    query: valid && !historyCriteriaError(valid) && Number.isSafeInteger(raw?.page) && raw!.page > 0 ? { ...valid, page: raw!.page } : null,
    draft: criteria(candidate?.draft),
    scrollY: Number.isFinite(candidate?.scrollY) ? Math.max(0, candidate!.scrollY!) : 0,
    scrollLeft: Number.isFinite(candidate?.scrollLeft) ? Math.max(0, candidate!.scrollLeft!) : 0,
    focusId: Number.isSafeInteger(candidate?.focusId) && candidate!.focusId! > 0 ? candidate!.focusId! : null };
}
// Only the last list visit is needed for native Back. No financial draft is stored.
let previousHistory: { key: string; value: HistoryReturn } | undefined;
export function rememberHistory(key: string, value: HistoryReturn) { previousHistory = { key, value }; }
export function recalledHistory(key: string) { return previousHistory?.key === key ? previousHistory.value : undefined; }
