import type { TransactionDetail } from "./types";

/** Fail closed before a partial/malformed response can replace a financial draft. */
export function isTransactionDetail(value: unknown, id: number): value is TransactionDetail {
  if (!value || typeof value !== "object") return false;
  const v = value as TransactionDetail;
  if (v.id !== id || typeof v.version !== "string" || !/^[0-9a-f]{32}$/.test(v.version)
    || typeof v.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)
    || typeof v.description !== "string" || typeof v.memo !== "string"
    || typeof v.entry_origin !== "string" || typeof v.editable !== "boolean"
    || !(v.source_rule_id === null || Number.isSafeInteger(v.source_rule_id))
    || !["regular", "opening", "legacy_opening_zero"].includes(v.kind)
    || !Array.isArray(v.tags) || !v.tags.every(tag => typeof tag === "string")
    || !Array.isArray(v.postings) || v.postings.length < 2) return false;
  const ids = new Set<number>();
  for (const p of v.postings) {
    if (!p || !Number.isSafeInteger(p.posting_id) || p.posting_id <= 0 || ids.has(p.posting_id)
      || !Number.isSafeInteger(p.account_id) || p.account_id <= 0 || !Number.isSafeInteger(p.amount)
      || typeof p.currency !== "string" || (v.editable && p.currency !== "KRW")) return false;
    ids.add(p.posting_id);
  }
  if (v.kind === "regular") return v.opening_system_id === null;
  return v.postings.length === 2 && Number.isSafeInteger(v.opening_system_id)
    && v.postings.filter(p => p.account_id === v.opening_system_id).length === 1
    && v.postings[0].amount + v.postings[1].amount === 0;
}
