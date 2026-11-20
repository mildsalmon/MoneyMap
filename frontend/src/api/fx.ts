import { req } from "./core";

export const scales = { USD: 2, JPY: 0, EUR: 2, BHD: 3 };
export type Currency = keyof typeof scales;

export interface Quote { currency: Currency; rate: string; rate_date: string; source: string }
export interface Trade extends Quote {
  side: "buy" | "sell"; bank_id: number; day: string; quantity: string; cash: string; fee: string;
}
export interface Recorded extends Omit<Trade, "quantity"> {
  id: number; version: number; minor: string; principal: string; krw_txn: number; native_txn: number;
  legacy_txn: number | null; source_file: string | null; source_row: number | null; source_hash: string | null; backup: string | null;
}
interface Balance {
  account_id: number; name: string; currency: string; minor: string; value: string | null;
  cost: string | null; unrealized: string | null; realized: string | null; fees: string | null;
}
interface Report {
  balances: Balance[]; quotes: Partial<Record<Currency, Quote>>; trades: Recorded[];
  foreign_subtotal: string; valued_net: string; missing: number; krw: string;
}
export interface Candidate {
  transaction_id: number; day: string; bank_id: number; cash: string; source_file: string; source_row: number; source_hash: string;
}
export interface Preview { preview_hash: string; before: Record<string,string>; after: Record<string,string>; original: Candidate }
const body = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
export const fx = {
  report: (day: string, signal: AbortSignal) => req<Report>(`/fx?day=${day}`, { signal }),
  candidates: (signal: AbortSignal) => req<Candidate[]>("/fx/legacy", { signal }),
  save: (trade: Trade, request_id: string, original?: Recorded) => req<{id: number}>(
    original ? `/fx/trades/${original.id}` : "/fx/trades",
    body(original ? "PUT" : "POST", { trade, request_id, expected_version: original?.version ?? 0 })),
  quote: (quote: Quote) => req("/fx/quotes", body("PUT", quote)),
  preview: (trade: Trade, transaction_id: number) => req<Preview>("/fx/legacy/preview", body("POST", { trade, transaction_id })),
  apply: (trade: Trade, transaction_id: number, preview_hash: string) =>
    req<{id: number}>("/fx/legacy/apply", body("POST", { trade, transaction_id, preview_hash })),
};
export function nativeQuantity(minor: string, currency: Currency) {
  const digits = scales[currency];
  const padded = minor.padStart(digits + 1, "0");
  return digits ? padded.slice(0, -digits) + "." + padded.slice(-digits) : padded;
}
