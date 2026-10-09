import { req } from "./core";
import type { Rule, RuleBody } from "./types";

export const rulesApi = {
  rules: (scenarioId = 1, signal?: AbortSignal) => req<Rule[]>(`/rules?scenario_id=${scenarioId}`, { signal }),
  createRule: (b: RuleBody) => req<Rule>("/rules", { method: "POST", body: JSON.stringify(b) }),
  updateRule: (id: number, b: RuleBody, token: string) =>
    req<Rule>(`/rules/${id}`, { method: "PUT", headers: { "If-Match": token }, body: JSON.stringify(b), signal: AbortSignal.timeout(15_000) }),
  deleteRule: (id: number) => req<{ deleted: number }>(`/rules/${id}`, { method: "DELETE" }),
  materialize: () =>
    req<{ created: number; transactions: { id: number; date: string; description: string }[] }>(
      "/materialize",
      { method: "POST" },
    ),

};
