// 백엔드 API 클라이언트 — 실행 분리 구조(D17-eng)라 절대 주소 사용

const BASE = "http://127.0.0.1:8765/api";

export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  parent_id: number | null;
  currency: string;
  archived: boolean;
  is_placeholder: boolean;
  is_system: boolean;
}

export interface Posting {
  account_id: number;
  amount: { amount: number; currency: string };
}

export interface Txn {
  id: number;
  scenario_id: number;
  date: string;
  description: string;
  source_rule_id: number | null;
  postings: Posting[];
}

export interface Rule {
  id: number;
  scenario_id: number;
  description: string;
  from_account_id: number;
  to_account_id: number;
  amount: { amount: number; currency: string };
  schedule: { spec: string };
  start_date: string;
  end_date: string | null;
  last_materialized: string | null;
}

export interface Scenario {
  id: number;
  name: string;
  base_scenario_id: number | null;
  fork_date: string | null;
}

export interface SeriesPoint {
  date: string;
  net_worth: number;
}

export interface Series {
  id: number | string;
  name: string;
  kind: "actual" | "baseline" | "scenario";
  basis?: { monthly_variable_spend: number };
  points: SeriesPoint[];
}

export interface BalanceRow {
  account_id: number;
  name: string;
  type: AccountType;
  balance: number;
  display_balance: number;
}

export interface RuleBody {
  scenario_id?: number;
  description?: string;
  from_account_id: number;
  to_account_id: number;
  amount: number;
  schedule: string;
  start_date: string;
  end_date?: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* body 없음 */
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json();
}

export const api = {
  health: () => req<{ status: string }>("/health"),
  accounts: () => req<Account[]>("/accounts"),
  createAccount: (b: { name: string; type: AccountType; parent_id?: number | null; is_placeholder?: boolean }) =>
    req<Account>("/accounts", { method: "POST", body: JSON.stringify(b) }),
  updateAccount: (id: number, b: { name: string }) =>
    req<Account>(`/accounts/${id}`, { method: "PATCH", body: JSON.stringify(b) }),
  seedStandardAccounts: () =>
    req<{ created: number; skipped: number }>("/accounts/seed-standard", { method: "POST" }),
  archiveAccount: (id: number) => req<Account>(`/accounts/${id}/archive`, { method: "POST" }),
  restoreAccount: (id: number) => req<Account>(`/accounts/${id}/restore`, { method: "POST" }),
  setPlaceholder: (id: number, is_placeholder: boolean) =>
    req<Account>(`/accounts/${id}/placeholder`, { method: "POST", body: JSON.stringify({ is_placeholder }) }),
  reclassifyDirect: (id: number, to: number) =>
    req<{ moved_postings: number; to: number }>(`/accounts/${id}/reclassify-direct?to=${to}`, { method: "POST" }),
  transactions: (scenarioId = 1) => req<Txn[]>(`/transactions?scenario_id=${scenarioId}`),
  createTransaction: (b: {
    scenario_id?: number;
    date: string;
    description?: string;
    postings: { account_id: number; amount: number }[];
  }) => req<Txn>("/transactions", { method: "POST", body: JSON.stringify(b) }),
  deleteTransaction: (id: number) => req<{ deleted: number }>(`/transactions/${id}`, { method: "DELETE" }),
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
  scenarios: () => req<Scenario[]>("/scenarios"),
  createScenario: (b: { name: string; fork_date: string }) =>
    req<Scenario & { copied_rules: number }>("/scenarios", { method: "POST", body: JSON.stringify(b) }),
  balances: (scenarioId = 1) =>
    req<{ at: string; net_worth: number; accounts: BalanceRow[] }>(`/balances?scenario_id=${scenarioId}`),
  projection: (months: number, scenarioIds: number[]) =>
    req<{ series: Series[] }>(`/projection?months=${months}&scenario_ids=${scenarioIds.join(",")}`),
};

/** 계정 트리 정렬: 유형 순 → 루트 이름 순 → 자식은 부모 바로 아래 (depth 포함) */
const TYPE_ORDER: AccountType[] = ["asset", "liability", "income", "expense", "equity"];

export function accountTree(accounts: Account[]): { account: Account; depth: number }[] {
  const byParent = new Map<number | null, Account[]>();
  for (const a of accounts) {
    const key = a.parent_id ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), a]);
  }
  const out: { account: Account; depth: number }[] = [];
  const walk = (parent: number | null, depth: number, type?: AccountType) => {
    const children = (byParent.get(parent) ?? [])
      .filter((a) => !type || a.type === type)
      .sort((x, y) => x.name.localeCompare(y.name, "ko"));
    for (const a of children) {
      out.push({ account: a, depth });
      walk(a.id, depth + 1);
    }
  };
  for (const t of TYPE_ORDER) walk(null, 0, t);
  return out;
}

/** 자식 포함 합산 잔액용: 계정 id → 자기+모든 후손 id 목록 */
export function withDescendants(accounts: Account[], id: number): number[] {
  const out = [id];
  for (const a of accounts) {
    if (a.parent_id === id) out.push(...withDescendants(accounts, a.id));
  }
  return out;
}

/** 기장 가능 계정 = 보관 안 됨 AND 그룹 아님(placeholder도, 자식도 없음) — D23·D24 */
export function isPostable(accounts: Account[], a: Account): boolean {
  if (a.archived || a.is_placeholder) return false;
  return !accounts.some((c) => c.parent_id === a.id);
}

/** 그룹(대분류) 여부 = placeholder이거나 자식이 있음 */
export function isGroup(accounts: Account[], a: Account): boolean {
  return a.is_placeholder || accounts.some((c) => c.parent_id === a.id);
}

/** 시나리오 '차트에 표시' 토글 — 클라이언트 상태 (최대 3개, D19) */
export const chartToggles = {
  get(): number[] {
    try {
      return JSON.parse(localStorage.getItem("moneymap.chart_scenarios") ?? "[]");
    } catch {
      return [];
    }
  },
  set(ids: number[]) {
    localStorage.setItem("moneymap.chart_scenarios", JSON.stringify(ids.slice(0, 3)));
  },
};
