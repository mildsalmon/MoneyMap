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
  scenario_id?: number;
  description?: string;
  from_account_id: number;
  to_account_id: number;
  amount: number;
  schedule: string;
  start_date: string;
  end_date?: string | null;
}

