import { req } from "./core";
import type { Series, BalanceRow } from "./types";

export const reportingApi = {
  balances: (scenarioId = 1) =>
    req<{ at: string; net_worth: number; accounts: BalanceRow[] }>(`/balances?scenario_id=${scenarioId}`),
  projection: (months: number, scenarioIds: number[]) =>
    req<{ series: Series[] }>(`/projection?months=${months}&scenario_ids=${scenarioIds.join(",")}`),
};
