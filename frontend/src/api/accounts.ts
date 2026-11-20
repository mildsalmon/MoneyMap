import { req } from "./core";
import type { AccountType, Account, AccountSettingsResult, AccountReorderCommand, AccountReorderResult } from "./types";

export interface AccountStateEvent {
  seq: number; batch: string; account_id: number; action: string;
  before_state: Record<string, number | string | null> | null;
  after_state: Record<string, number | string | null>;
  recorded_at: string; applied_at: string; revision: number;
}
interface AccountStateHistory {
  started_at: string; events: AccountStateEvent[];
  intervals: { start: string; end: string | null; reason: "system" | "archived" | "group" | "postable" | "not_created" }[];
  corrections: { revision: number; batch: string; previous_at: string; effective_at: string; recorded_at: string }[];
}

export const accountsApi = {
  reorderAccounts: (body: AccountReorderCommand) => req<AccountReorderResult>("/accounts/reorder", {
    method: "PUT", body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  }),
  accounts: (signal?: AbortSignal) => req<Account[]>("/accounts", { signal }),
  datedAccounts: (day: string, signal?: AbortSignal) =>
    day ? req<Account[]>(`/accounts?on=${encodeURIComponent(day)}`, { signal }) : Promise.resolve([]),
  accountStateHistory: (id: number, signal?: AbortSignal) =>
    req<AccountStateHistory>(`/accounts/${id}/state-history`, { signal }),
  correctAccountDate: (id: number, seq: number, day: string, revision: number) =>
    req<AccountStateHistory>(`/accounts/${id}/state-history/${seq}/corrections`, {
      method: "POST", body: JSON.stringify({ effective_date: day, expected_revision: revision }),
    }),
  accountCreationResult: (key: string) => req<Account | null>(
    `/accounts/creation-requests/${key}`, { signal: AbortSignal.timeout(15_000) }),
  createAccount: (b: {
    request_id?: string;
    parent_versions?: Record<number, number>;
    name: string;
    type: AccountType;
    parent_id?: number | null;
    is_placeholder?: boolean;
    is_overdraft?: boolean;
  }) =>
    req<Account>("/accounts", { method: "POST", body: JSON.stringify(b), signal: AbortSignal.timeout(15_000) }),
  updateAccountSettings: (id: number, b: {
    parent_versions?: Record<number, number>;
    name: string;
    parent_id: number | null;
    is_overdraft: boolean;
    include_in_cash: boolean;
    version: number;
  }) => req<AccountSettingsResult>(`/accounts/${id}/settings`, {
    method: "PUT",
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(b),
  }),
  seedStandardAccounts: () =>
    req<{ created: number; skipped: number }>("/accounts/seed-standard", { method: "POST" }),
  archiveAccount: (id: number, day?: string) => req<Account>(`/accounts/${id}/archive${day ? `?effective_date=${encodeURIComponent(day)}` : ""}`, { method: "POST" }),
  restoreAccount: (id: number, day?: string) => req<Account>(`/accounts/${id}/restore${day ? `?effective_date=${encodeURIComponent(day)}` : ""}`, { method: "POST" }),
  setPlaceholder: (id: number, is_placeholder: boolean) =>
    req<Account>(`/accounts/${id}/placeholder`, { method: "POST", body: JSON.stringify({ is_placeholder }) }),
  reclassifyDirect: (id: number, to: number) =>
    req<{ moved_postings: number; to: number }>(`/accounts/${id}/reclassify-direct?to=${to}`, { method: "POST" }),

};
