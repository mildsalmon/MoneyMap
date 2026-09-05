import { req } from "./core";
import type { Txn, OpeningBalanceRecord } from "./types";

export const transactionsApi = {
  transactions: (scenarioId = 1, signal?: AbortSignal) => req<Txn[]>(`/transactions?scenario_id=${scenarioId}`, { signal }),
  openingBalances: (signal?: AbortSignal) => req<OpeningBalanceRecord[]>("/opening-balances", { signal }),
  createOpeningBalance: (
    id: number,
    b: { date: string; amount: number; state: "positive" | "negative" },
  ) => req<Txn>(`/accounts/${id}/opening-balance`, {
    method: "POST",
    body: JSON.stringify(b),
  }),
  createTransaction: (b: {
    date: string;
    description?: string;
    postings: { account_id: number; amount: number }[];
  }) => req<Txn>("/transactions", { method: "POST", body: JSON.stringify(b) }),
  deleteTransaction: (id: number) => req<{ deleted: number }>(`/transactions/${id}`, { method: "DELETE" }),

};
