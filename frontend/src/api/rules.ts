import { req } from "./core";
import type { Rule, RuleBody } from "./types";

export const rulesApi = {
  rules: (scenarioId = 1) => req<Rule[]>(`/rules?scenario_id=${scenarioId}`),
  createRule: (b: RuleBody) => req<Rule>("/rules", { method: "POST", body: JSON.stringify(b) }),
  updateRule: (id: number, b: RuleBody) =>
    req<Rule>(`/rules/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  deleteRule: (id: number) => req<{ deleted: number }>(`/rules/${id}`, { method: "DELETE" }),
  materialize: () =>
    req<{ created: number; transactions: { id: number; date: string; description: string }[] }>(
      "/materialize",
      { method: "POST" },
    ),

};
