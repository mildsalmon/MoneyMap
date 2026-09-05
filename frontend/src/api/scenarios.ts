import { req } from "./core";
import type { Scenario } from "./types";

export const scenariosApi = {
  scenarios: () => req<Scenario[]>("/scenarios"),
  createScenario: (b: { name: string; fork_date: string }) =>
    req<Scenario & { copied_rules: number }>("/scenarios", { method: "POST", body: JSON.stringify(b) }),

};
