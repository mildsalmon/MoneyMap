import { req, reqWithHeaders } from "./core";
import type { Scenario, Txn, PlannedBody, Rule, RuleBody, EffectiveRule, Projection, DeletionImpact, LegacyResolution, ResolutionBody } from "./types";

const mutation = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
export const scenarioEtag = (id: number, version: number) => `"scenario-${id}-v${version}"`;
export const scenariosApi = {
  duplicateScenario: (
    id: number,
    body: {
      name: string;
      description: string;
      fork_date: string;
      version: number;
    },
  ) =>
    req<{
      scenario: Scenario;
      copied: { rules: number; planned_transactions: number };
    }>(`/scenarios/${id}/duplicate`, mutation("POST", body)),
  plannedTransactions: (id: number, signal?: AbortSignal) =>
    req<Txn[]>(`/scenarios/${id}/planned-transactions`, { signal }),
  createPlanned: (id: number, body: PlannedBody) =>
    req<{ transaction: Txn; scenario_version: number }>(
      `/scenarios/${id}/planned-transactions`,
      mutation("POST", body),
    ),
  updatePlanned: (id: number, tid: number, body: PlannedBody) =>
    req<{ transaction: Txn; scenario_version: number }>(
      `/scenarios/${id}/planned-transactions/${tid}`,
      mutation("PUT", body),
    ),
  deletePlanned: (id: number, tid: number, version: number) =>
    req<{ deleted: number; scenario_version: number }>(
      `/scenarios/${id}/planned-transactions/${tid}`,
      { method: "DELETE", headers: { "If-Match": scenarioEtag(id, version) } },
    ),
  scenarios: (status: "active" | "archived" = "active", signal?: AbortSignal) => req<Scenario[]>(`/scenarios?status=${status}`, { signal }),
  scenario: (id: number, signal?: AbortSignal) => req<Scenario>(`/scenarios/${id}`, { signal }),
  createScenario: (body: { name: string; description: string; fork_date: string }) => req<{ scenario: Scenario; effective_actual_rules: number }>("/scenarios", mutation("POST", body)),
  editScenario: (id: number, body: { name: string; description: string; version: number }) => req<Scenario>(`/scenarios/${id}`, mutation("PATCH", body)),
  transitionScenario: (id: number, action: "archive" | "restore", version: number) => req<Scenario>(`/scenarios/${id}/${action}`, mutation("POST", { version })),
  deletionImpact: async (id: number, signal?: AbortSignal) => {
    const response = await reqWithHeaders<DeletionImpact>(`/scenarios/${id}/deletion-impact`, { signal });
    const etag = response.headers.get("ETag");
    if (!etag) throw new Error("삭제 영향 버전을 읽지 못했습니다. 다시 불러오세요.");
    return { impact: response.data, etag };
  },
  deleteScenario: (id: number, etag: string) => req<{ deleted: number } & Omit<DeletionImpact, "name" | "scenario_id" | "version">>(`/scenarios/${id}`, { method: "DELETE", headers: { "If-Match": etag } }),
  effectiveRules: (id: number, signal?: AbortSignal) => req<EffectiveRule[]>(`/scenarios/${id}/effective-rules`, { signal }),
  createScenarioRule: (id: number, body: RuleBody & { scenario_version: number }) => req<{ rule: Rule; scenario_version: number }>(`/scenarios/${id}/rules`, mutation("POST", body)),
  updateScenarioRule: (id: number, rid: number, body: RuleBody & { scenario_version: number }) => req<{ rule: Rule; scenario_version: number }>(`/scenarios/${id}/rules/${rid}`, mutation("PUT", body)),
  deleteScenarioRule: (id: number, rid: number, version: number) => req<{ deleted: number; scenario_version: number }>(`/scenarios/${id}/rules/${rid}`, { method: "DELETE", headers: { "If-Match": scenarioEtag(id, version) } }),
  scenarioProjection: (id: number, months: number, signal?: AbortSignal) => req<Projection>(`/projection?scenario_id=${id}&months=${months}`, { signal }),
  legacyResolution: (id: number, signal?: AbortSignal) => req<LegacyResolution>(`/scenarios/${id}/legacy-rule-resolution`, { signal }),
  resolveLegacy: (id: number, body: ResolutionBody) => req<{ scenario: Scenario }>(`/scenarios/${id}/legacy-rule-resolution`, mutation("POST", body)),
};
