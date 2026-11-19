import { req } from "./core";

export interface Statement {
  account_id: number;
  currency: string;
  closing_date: string;
  statement_minor: string;
}

export interface Comparison {
  ledger_minor: string;
  difference_minor: string;
  posting_minor: string;
  preview_version: string;
}

export interface Adjustment {
  statement: Statement;
  preview_version: string;
  request_id: string;
  counterpart_id: number;
  reason: string;
}

export const compare = (statement: Statement) => req<Comparison>("/reconciliation/preview", {
  method: "POST", body: JSON.stringify(statement), signal: AbortSignal.timeout(15000),
});

export const confirmAdjustment = (command: Adjustment) => req<{ transaction_id: number }>("/reconciliation/confirm", {
  method: "POST", body: JSON.stringify(command), signal: AbortSignal.timeout(15000),
});
