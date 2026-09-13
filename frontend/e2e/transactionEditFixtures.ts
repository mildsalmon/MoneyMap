import type { Account, TransactionDetail, TransactionEditBody } from "../src/api/types";

export const editAccounts: Account[] = [
  { id: 101, name: "식비", type: "expense" },
  { id: 102, name: "현금", type: "asset" },
  { id: 103, name: "카드", type: "liability" },
  { id: 104, name: "교통", type: "expense" },
  { id: 105, name: "개시잔액", type: "equity", is_system: true },
  { id: 106, name: "보관계정", type: "asset", archived: true },
].map((a, position) => ({ parent_id: null, currency: "KRW", archived: false, is_placeholder: false,
  is_system: false, is_overdraft: false, version: 1, position, ...a } as Account));

export const makeDetail = (overrides: Partial<TransactionDetail> = {}): TransactionDetail => ({
  id: 71, version: "a".repeat(32), date: "2026-01-02", description: "원래 내역", memo: "원본 메모\n둘째 줄", tags: ["데이트"],
  entry_origin: "manual", source_rule_id: null, kind: "regular", opening_system_id: null, editable: true,
  postings: [{ posting_id: 11, account_id: 101, amount: 100, currency: "KRW" }, { posting_id: 12, account_id: 102, amount: -100, currency: "KRW" }], ...overrides,
});
export function applied(original: TransactionDetail, submitted: TransactionEditBody) {
  const transaction = { ...original, date: submitted.date, description: submitted.description, memo: submitted.memo,
    tags: submitted.tags, version: "b".repeat(32), postings: submitted.postings?.map((p, i) => ({ ...p, posting_id: p.posting_id ?? 20 + i, currency: "KRW" })) ?? original.postings };
  return { request_id: submitted.request_id, outcome: "applied", result_version: transaction.version, transaction };
}
