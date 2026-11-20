import { req } from "./core";

export interface InstallmentRow {
  id: number; plan_id: number; number: number; due_date: string;
  principal: number; settled: number; remaining: number;
  interest: number | null; fee: number | null; cancelled_interest: number; early_fee: number;
  remaining_interest: number; remaining_fee: number; unpaid_total: number; unknown_cost: boolean;
  status: "paid" | "needs_confirmation" | "scheduled";
}
export interface Allocation {
  transaction_id: number; installment_id: number; amount: number;
  interest: number; fee: number; interest_charge_id: number | null; fee_charge_id: number | null;
  kind: "payment" | "refund" | "charge" | "billed_payment" | "rebate" | "charge_refund"; date: string; description: string;
}
export interface InstallmentPlan {
  id: number; purchase_id: number; description: string; purchase_date: string;
  debit_account_id: number; card_account_id: number; cash_account_id: number;
  interest_account_id: number | null; fee_account_id: number | null; unpaid_total: number;
  principal: number; remaining_principal: number; next_due_date: string | null; completion_date: string | null;
  projection_mode: "pending" | "separate" | "included";
  current_rule_signature: string; needs_projection_decision: boolean;
  conflicting_rules: {id: number; description: string; amount: number}[];
  installments: InstallmentRow[]; allocations: Allocation[];
}
export interface InstallmentList {revision: number; as_of: string; plans: InstallmentPlan[]}
export interface CandidateTransaction {id: number; date: string; description: string; postings: {account_id: number; amount: number}[]}
export const installmentsApi = {
  installments: (signal?: AbortSignal) => req<InstallmentList>("/installments", {signal}),
  installmentCandidates: (q: string, signal?: AbortSignal) => req<CandidateTransaction[]>(`/installments/transactions?q=${encodeURIComponent(q)}`, {signal}),
};
