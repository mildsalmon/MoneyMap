import { req } from "./core";
import type { Series, BalanceRow } from "./types";
import type { Statistics } from "./statistics";

export const reportingApi = {
  statistics: (start: string, end: string, signal?: AbortSignal, options?: URLSearchParams) => {
    const params = new URLSearchParams(options);
    params.set("start", start);
    params.set("end", end);
    return req<Statistics>(`/statistics?${params}`, { signal });
  },
  balances: (scenarioId = 1, signal?: AbortSignal) =>
    req<{ at: string; net_worth: number; accounts: BalanceRow[] }>(`/balances?scenario_id=${scenarioId}`, { signal }),
  dashboardBalances: async (signal?: AbortSignal) => {
    const result = await req<{ net_worth: string; accounts: (Omit<BalanceRow, "balance" | "display_balance"> & { balance: string })[] }>(
      "/balances?scenario_id=1&krw_only=true", { signal });
    return { net_worth: BigInt(result.net_worth), accounts: result.accounts.map(row => ({ ...row, balance: BigInt(row.balance) })) };
  },
  projection: (months: number, scenarioIds: number[], signal?: AbortSignal) =>
    req<{ series: Series[]; warnings?: string[] }>(`/dashboard-projection?months=${months}&scenario_ids=${scenarioIds.join(",")}`, { signal }),
};
