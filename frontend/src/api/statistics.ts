import type { Account, AccountType } from "./types";
export interface FlowTotals { income: number; expense: number }
export interface FlowComparison { current: FlowTotals; previous: FlowTotals }
export interface ComparisonPeriod { start: string; end: string; days: number }
export interface StatisticsComparison {
  current: ComparisonPeriod;
  previous: ComparisonPeriod | null;
  overall: FlowComparison;
  tags: (FlowComparison & { tag_id: number; name: string })[];
  categories: { id: number; name: string }[];
  details?: { has_more: boolean; items: (FlowTotals & { id: number; date: string; description: string })[] };
}
export interface Statistics {
  comparison?: StatisticsComparison;
  start: string; end: string; as_of: string; currency: "KRW";
  transaction_count: number; excluded_transaction_count: number;
  summary: { income: number; expense: number; net_income: number; opening_net_worth: number;
    net_worth: number; net_worth_change: number; assets: number; liabilities: number;
    capital_change: number; reconciliation_difference: number };
  categories: { category_id: number | null; name: string; expense: number; income: number }[];
  monthly: { month: string; through: string; income: number; expense: number;
    net_income: number; capital_change: number; net_worth: number }[];
  accounts: Account[];
  balances: { account_id: number; opening: number; balance: number; period: number;
    activity: number; reporting_type: AccountType }[];
}
