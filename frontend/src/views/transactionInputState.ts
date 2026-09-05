/** One draft owns both modes. Request epoch guards the draft; each side's
 * revision separately protects manual edits. Successful saves clear fields
 * only when the submitted revision still owns the current draft. */
import type { LastPair } from "../api";

export type Side = "debit" | "credit";
export type Choice = { account: number | null; source: "empty" | "auto" | "manual" | "retained"; revision: number };
export type SplitRow = { id: number; account: number | null; amount: string; debit: boolean };
export type Draft = {
  date: string; item: string; memo: string; amount: string;
  mode: "basic" | "split"; debit: Choice; credit: Choice; rows: SplitRow[];
  epoch: number; revision: number;
};
export type LookupToken = { key: string; epoch: number; debit: number; credit: number };
const emptyChoice = (): Choice => ({ account: null, source: "empty", revision: 0 });
export const itemKey = (value: string) => value.normalize("NFC").replace(/^[\s\u0085\u001c-\u001f]+|[\s\u0085\u001c-\u001f]+$/g, "");

export function newDraft(date: string): Draft {
  return { date, item: "", memo: "", amount: "", mode: "basic", debit: emptyChoice(), credit: emptyChoice(), rows: [], epoch: 0, revision: 0 };
}

export function amountValue(value: string): number {
  if (!/^[\d,]+$/.test(value)) return NaN;
  const n = Number(value.replace(/,/g, ""));
  return Number.isSafeInteger(n) ? n : NaN;
}

export function amountInput(value: string): string {
  if (!value) return "";
  const n = amountValue(value);
  return Number.isFinite(n) ? n.toLocaleString("ko-KR") : value;
}

export function editField(draft: Draft, field: "date" | "item" | "memo" | "amount", value: string): Draft {
  const next = { ...draft, [field]: value, revision: draft.revision + 1 };
  if (field === "item" && itemKey(value) !== itemKey(draft.item)) {
    next.epoch++;
    for (const side of ["debit", "credit"] as const) {
      if (draft[side].source !== "manual") next[side] = { ...emptyChoice(), revision: draft[side].revision + 1 };
    }
  }
  return next;
}

export function chooseAccount(draft: Draft, side: Side, account: number): Draft {
  return { ...draft, revision: draft.revision + 1, [side]: { account, source: "manual", revision: draft[side].revision + 1 } };
}

export function lookupToken(draft: Draft): LookupToken {
  return { key: itemKey(draft.item), epoch: draft.epoch, debit: draft.debit.revision, credit: draft.credit.revision };
}

export function isCurrentLookup(draft: Draft, token: LookupToken) {
  return draft.mode === "basic" && draft.epoch === token.epoch && itemKey(draft.item) === token.key;
}

export function applyPair(draft: Draft, token: LookupToken, pair: LastPair, confirmed = false): Draft {
  if (!isCurrentLookup(draft, token) || pair.item_key !== token.key) return draft;
  const usable = pair.status === "matched" || (confirmed && pair.status === "legacy_confirmation_required");
  let next = draft;
  for (const side of ["debit", "credit"] as const) {
    if (draft[side].source === "manual" || draft[side].revision !== token[side]) continue;
    const account = usable ? pair[`${side}_account_id`] : null;
    const source = account === null ? "empty" : confirmed ? "manual" : "auto";
    if (account !== draft[side].account || source !== draft[side].source) {
      next = { ...next, [side]: { ...draft[side], account, source }, revision: draft.revision + 1 };
    }
  }
  return next;
}

export function switchMode(draft: Draft): { draft: Draft; error?: string } {
  const next = { ...draft, epoch: draft.epoch + 1, revision: draft.revision + 1 };
  if (draft.mode === "basic") {
    return { draft: { ...next, mode: "split", rows: [
      { id: 1, account: draft.debit.account, amount: draft.amount, debit: true },
      { id: 2, account: draft.credit.account, amount: draft.amount, debit: false },
    ] } };
  }
  const blank = draft.rows.every(row => row.account === null && row.amount === "");
  const debits = draft.rows.filter(row => row.debit), credits = draft.rows.filter(row => !row.debit);
  if (!blank && (draft.rows.length !== 2 || debits.length !== 1 || credits.length !== 1
      || debits[0].amount !== credits[0].amount
      || (debits[0].account !== null && debits[0].account === credits[0].account))) {
    return { draft, error: "기본 입력으로 옮기려면 차변·대변 한 행씩, 같은 금액으로 정리하세요. 작성한 내용은 유지했습니다." };
  }
  const choice = (row: SplitRow | undefined, previous: Choice): Choice => ({
    account: blank ? null : row?.account ?? null,
    source: blank || !row?.account ? "empty" : "manual", revision: previous.revision + 1,
  });
  return { draft: { ...next, mode: "basic", amount: blank ? "" : debits[0].amount,
    debit: choice(debits[0], draft.debit), credit: choice(credits[0], draft.credit) } };
}

export function clearSavedDraft(draft: Draft, submitted: Draft): Draft {
  if (draft.revision !== submitted.revision) return { ...draft, epoch: draft.epoch + 1 };
  return { ...draft, amount: "", memo: "", epoch: draft.epoch + 1, revision: draft.revision + 1,
    debit: { ...draft.debit, source: draft.debit.account ? "retained" : "empty", revision: draft.debit.revision + 1 },
    credit: { ...draft.credit, source: draft.credit.account ? "retained" : "empty", revision: draft.credit.revision + 1 },
    rows: draft.rows.map(row => ({ ...row, amount: "" })),
  };
}

export function validateDraft(draft: Draft, availableIds: ReadonlySet<number>) {
  const rows: SplitRow[] = draft.mode === "split" ? draft.rows : [
    { id: 1, account: draft.debit.account, amount: draft.amount, debit: true },
    { id: 2, account: draft.credit.account, amount: draft.amount, debit: false },
  ];
  const errors: Record<number, string> = {};
  const postings: { account_id: number; amount: number }[] = [];
  for (const row of rows) {
    // Only entirely untouched spare rows may be omitted. "0" is not blank.
    if (draft.mode === "split" && row.account === null && row.amount === "") continue;
    if (row.account === null) errors[row.id] = "계정을 선택하세요.";
    else if (!availableIds.has(row.account)) errors[row.id] = "지금 사용할 수 없는 계정입니다. 다시 선택하세요.";
    else if (!row.amount) errors[row.id] = "금액을 입력하세요.";
    else if (!(amountValue(row.amount) > 0)) errors[row.id] = "0보다 큰 정수 금액을 입력하세요.";
    else postings.push({ account_id: row.account, amount: (row.debit ? 1 : -1) * amountValue(row.amount) });
  }
  const debit = postings.filter(p => p.amount > 0).reduce((sum, p) => sum + p.amount, 0);
  const credit = -postings.filter(p => p.amount < 0).reduce((sum, p) => sum + p.amount, 0);
  let message = Object.values(errors)[0] ?? "";
  if (!message && postings.length < 2) message = "차변과 대변을 입력하세요.";
  if (!message && draft.mode === "basic" && draft.debit.account === draft.credit.account) message = "차변과 대변에 서로 다른 계정을 선택하세요.";
  if (!message && (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit))) message = "금액이 너무 큽니다.";
  if (!message && debit !== credit) message = "차변과 대변의 합계가 다릅니다.";
  if (!draft.date) message = "날짜를 입력하세요.";
  return { valid: !message, message, errors, debit, credit, postings: Object.keys(errors).length ? [] : postings };
}
