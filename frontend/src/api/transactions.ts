import { req } from "./core";
import { isTransactionDetail } from "./transactionEditResponse";
import type { Txn, HistoryPage, OpeningBalanceRecord, LastPair, RecentInput, TransactionDetail, TransactionEditBody, TransactionEditResult } from "./types";

type CreateTransactionBody = {
  date: string;
  description?: string;
  memo?: string;
  tags?: string[];
  postings: { account_id: number; amount: number }[];
};

const pendingCreates = new Map<string, Promise<Txn>>();

function createKey(body: CreateTransactionBody) {
  return JSON.stringify([
    body.date,
    body.description ?? "",
    body.memo ?? "",
    body.tags ?? [],
    body.postings.map(posting => [posting.account_id, posting.amount]),
  ]);
}

function createTransaction(body: CreateTransactionBody) {
  const key = createKey(body);
  const existing = pendingCreates.get(key);
  if (existing) return existing;
  const pending = req<Txn>("/transactions", {
    method: "POST",
    body: JSON.stringify(body),
  }).finally(() => {
    if (pendingCreates.get(key) === pending) pendingCreates.delete(key);
  });
  pendingCreates.set(key, pending);
  return pending;
}

export const transactionsApi = {
  transaction: async (id: number, signal?: AbortSignal) => {
    const result = await req<TransactionDetail>(`/transactions/${id}`, { signal });
    if (!isTransactionDetail(result, id)) throw new Error("거래 응답 형식을 확인할 수 없습니다");
    return result;
  },
  // A timeout is an unknown outcome, never permission to resend the write.
  editTransaction: (id: number, body: TransactionEditBody) => req<TransactionEditResult>(`/transactions/${id}`, { method: "PUT", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }),
  resolveTransactionEdit: (id: number, body: TransactionEditBody) => req<TransactionEditResult>(`/transactions/${id}/edit-result`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }),
  lastPair: (item: string, signal?: AbortSignal) => req<LastPair>(`/transaction-input/last-pair?item=${encodeURIComponent(item)}`, { signal }),
  recentInputs: (signal?: AbortSignal) => req<RecentInput[]>("/transaction-input/recent?limit=5", { signal }),
  transactions: (scenarioId = 1, signal?: AbortSignal) => req<Txn[]>(`/transactions?scenario_id=${scenarioId}`, { signal }),
  transactionHistory: (search: string, signal?: AbortSignal) => req<HistoryPage>(`/transaction-history${search}`, { signal }),
  tags: (signal?: AbortSignal) => req<string[]>("/tags", { signal }),
  openingBalances: (signal?: AbortSignal) => req<OpeningBalanceRecord[]>("/opening-balances", { signal }),
  createOpeningBalance: (
    id: number,
    b: { date: string; amount: number; state: "positive" | "negative" },
  ) => req<Txn>(`/accounts/${id}/opening-balance`, {
    method: "POST",
    body: JSON.stringify(b),
  }),
  createTransaction,
  deleteTransaction: (id: number) => req<{ deleted: number }>(`/transactions/${id}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) }),

};
