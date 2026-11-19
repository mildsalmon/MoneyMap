import { req } from "./core";
import type { Series, BalanceRow } from "./types";
import type { Statistics } from "./statistics";

export const reportingApi = {
  statistics: (start: string, end: string, signal?: AbortSignal) =>
    req<Statistics>(`/statistics?${new URLSearchParams({ start, end })}`, { signal }),
  balances: (scenarioId = 1, signal?: AbortSignal) =>
    req<{ at: string; net_worth: number; accounts: BalanceRow[] }>(`/balances?scenario_id=${scenarioId}`, { signal }),
  projection: (months: number, scenarioIds: number[], signal?: AbortSignal) =>
    req<{ series: Series[]; warnings?: string[] }>(`/dashboard-projection?months=${months}&scenario_ids=${scenarioIds.join(",")}`, { signal }),
};
