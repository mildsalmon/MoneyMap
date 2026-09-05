import { req } from "./core";
import type { Series, BalanceRow } from "./types";

export const reportingApi = {
  balances: (scenarioId = 1, signal?: AbortSignal) =>
    req<{ at: string; net_worth: number; accounts: BalanceRow[] }>(`/balances?scenario_id=${scenarioId}`, { signal }),
  projection: (months: number, scenarioIds: number[], signal?: AbortSignal) =>
    req<{ series: Series[] }>(`/dashboard-projection?months=${months}&scenario_ids=${scenarioIds.join(",")}`, { signal }),
};
