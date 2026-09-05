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
  is_overdraft: boolean;
  include_in_cash: boolean;
  position: number;
  version: number;
}

export interface AccountSettingsResult {
  account: Account;
  effects: {
    moved: boolean;
    previous_parent_id: number | null;
    source_parent_grouped: boolean;
  };
}

export interface Posting {
  account_id: number;
  amount: { amount: number; currency: string };
}

export interface Txn {
  memo: string;
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
  description: string;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  version: number;
  rule_mode: "live_additive" | "legacy_snapshot";
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
  reporting_type: AccountType;
  balance: number;
  display_balance: number;
}

export interface OpeningBalanceRecord {
  account_id: number;
  transaction_id: number;
  date: string;
  state: "positive" | "negative";
}

export interface StatusSummary {
  trial_balance_ok: boolean;
  last_entry: string | null;
  last_backup: string | null;
}

export interface RuleBody {
  description?: string;
  from_account_id: number;
  to_account_id: number;
  amount: number;
  schedule: string;
  start_date: string;
  end_date?: string | null;
}


export interface EffectiveRule { rule: Rule; origin: "actual" | "scenario"; editable: boolean }
export interface CashShortage {
  first_shortage: { start: string; end: string | null; days: number; through_horizon: boolean;
    reason?: "negative_start_balance"; triggering_items: { kind: string; id: number; label: string }[] };
  maximum_shortage: { date: string; balance: number };
}
export interface CashCurve { points: { date: string; balance: number }[]; shortage: CashShortage | null }
export interface Projection {
  cash?: { available: false; reason: "cash_accounts_not_configured" } | { available: true; baseline: CashCurve; scenario: CashCurve };
  fork_date: string; projection_start: string; projection_end: string; months: number;
  basis: { scenario_version: number; actual_ledger_revision: number; actual_rule_revision: number; cash_config_revision?: number };
  capabilities?: { scenario_liquidity?: unknown };
  net_worth: Record<"baseline" | "scenario", { points: { date: string; balance: number }[] }>;
  monthly_income_expense: { month: string; baseline: { income: number; expense: number }; scenario: { income: number; expense: number } }[];
  has_assumptions: boolean;
}
export interface DeletionImpact { scenario_id: number; name: string; rules: number; planned_transactions: number; generated_transactions: number; postings: number; version: number }
export interface LegacyResolution {
  scenario: Scenario;
  rules: { legacy_rule_id: number; rule: Rule; actual_candidates: Rule[] }[];
  transaction_conflicts: { id: number; date: string; description: string }[];
  generated_transactions: number;
}
export interface ResolutionBody {
  version: number;
  rule_decisions: { legacy_rule_id: number; action: "discard_snapshot" | "keep_as_scenario" }[];
  transaction_decisions: { transaction_id: number; action: "move" | "delete"; date?: string }[];
}

export interface LastPair {
  item_key: string;
  status: "matched" | "none" | "unavailable" | "legacy_confirmation_required";
  source_transaction_id: number | null;
  debit_account_id: number | null;
  credit_account_id: number | null;
  unavailable_reason: "split" | "invalid_pair" | "account_unavailable" | null;
}

export interface RecentInput {
  id: number; date: string; description: string; amount: number; posting_count: number;
  debit_account_id: number | null; credit_account_id: number | null;
}

export type PlannedBody = {
  date: string;
  description: string;
  postings: { account_id: number; amount: number; currency: string }[];
  scenario_version: number;
};
