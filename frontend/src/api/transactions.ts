import { req } from "./core";
import type { Txn, OpeningBalanceRecord, LastPair, RecentInput } from "./types";

type CreateTransactionBody = {
  date: string;
  description?: string;
  memo?: string;
  postings: { account_id: number; amount: number }[];
};

const pendingCreates = new Map<string, Promise<Txn>>();

function createKey(body: CreateTransactionBody) {
  return JSON.stringify([
    body.date,
    body.description ?? "",
    body.memo ?? "",
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
  lastPair: (item: string, signal?: AbortSignal) => req<LastPair>(`/transaction-input/last-pair?item=${encodeURIComponent(item)}`, { signal }),
  recentInputs: (signal?: AbortSignal) => req<RecentInput[]>("/transaction-input/recent?limit=5", { signal }),
  transactions: (scenarioId = 1, signal?: AbortSignal) => req<Txn[]>(`/transactions?scenario_id=${scenarioId}`, { signal }),
  openingBalances: (signal?: AbortSignal) => req<OpeningBalanceRecord[]>("/opening-balances", { signal }),
  createOpeningBalance: (
    id: number,
    b: { date: string; amount: number; state: "positive" | "negative" },
  ) => req<Txn>(`/accounts/${id}/opening-balance`, {
    method: "POST",
    body: JSON.stringify(b),
  }),
  createTransaction,
  deleteTransaction: (id: number) => req<{ deleted: number }>(`/transactions/${id}`, { method: "DELETE" }),

};
