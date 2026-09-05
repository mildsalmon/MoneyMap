import { req } from "./core";
import type { AccountType, Account, AccountSettingsResult } from "./types";

export const accountsApi = {
  accounts: (signal?: AbortSignal) => req<Account[]>("/accounts", { signal }),
  createAccount: (b: {
    name: string;
    type: AccountType;
    parent_id?: number | null;
    is_placeholder?: boolean;
    is_overdraft?: boolean;
  }) =>
    req<Account>("/accounts", { method: "POST", body: JSON.stringify(b) }),
  updateAccountSettings: (id: number, b: {
    name: string;
    parent_id: number | null;
    is_overdraft: boolean;
    version: number;
  }) => req<AccountSettingsResult>(`/accounts/${id}/settings`, {
    method: "PUT",
    body: JSON.stringify(b),
  }),
  seedStandardAccounts: () =>
    req<{ created: number; skipped: number }>("/accounts/seed-standard", { method: "POST" }),
  archiveAccount: (id: number) => req<Account>(`/accounts/${id}/archive`, { method: "POST" }),
  restoreAccount: (id: number) => req<Account>(`/accounts/${id}/restore`, { method: "POST" }),
  setPlaceholder: (id: number, is_placeholder: boolean) =>
    req<Account>(`/accounts/${id}/placeholder`, { method: "POST", body: JSON.stringify({ is_placeholder }) }),
  reclassifyDirect: (id: number, to: number) =>
    req<{ moved_postings: number; to: number }>(`/accounts/${id}/reclassify-direct?to=${to}`, { method: "POST" }),

};
