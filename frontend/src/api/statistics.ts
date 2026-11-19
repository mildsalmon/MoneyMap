import type { Account, AccountType } from "./types";
export interface Statistics {
  start: string; end: string; as_of: string; currency: "KRW";
  transaction_count: number; excluded_transaction_count: number;
  summary: { income: number; expense: number; net_income: number; opening_net_worth: number;
    net_worth: number; net_worth_change: number; assets: number; liabilities: number;
    capital_change: number; reconciliation_difference: number };
  monthly: { month: string; through: string; income: number; expense: number;
    net_income: number; capital_change: number; net_worth: number }[];
  accounts: Account[];
  balances: { account_id: number; opening: number; balance: number; period: number;
    activity: number; reporting_type: AccountType }[];
}
