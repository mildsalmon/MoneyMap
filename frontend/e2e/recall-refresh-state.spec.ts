import { test, expect } from "./test";
import { newDraft, editField, chooseAccount, lookupToken, applyPair, clearSavedDraft, inputSaveGate, switchMode, validateDraft } from "../src/views/transactionInputState";
import type { LastPair } from "../src/api";

const pair = (item_key: string, debit_account_id = 1, credit_account_id = 2): LastPair =>
  ({ item_key, debit_account_id, credit_account_id, status: "matched", source_transaction_id: 1, unavailable_reason: null });
const start = () => editField(newDraft("2026-09-20"), "item", "A");
const auto = () => { const d = start(); return applyPair(d, lookupToken(d), pair("A")); };

test("auto and retained refresh through A B C without changing unrelated fields", () => {
  let d = { ...auto(), amount: "100", memo: "memo", tags: ["tag"] };
  d = editField(d, "item", "B");
  d = applyPair(d, lookupToken(d), pair("B", 3, 4));
  expect([d.debit.account, d.credit.account]).toEqual([3, 4]);
  expect([d.amount, d.memo, d.tags, d.date]).toEqual(["100", "memo", ["tag"], "2026-09-20"]);
  d = clearSavedDraft(d, d);
  expect(d.debit.source).toBe("retained");
  d = editField(d, "item", "C");
  d = applyPair(d, lookupToken(d), pair("C", 5, 6));
  expect([d.debit.account, d.credit.account, d.debit.source]).toEqual([5, 6, "auto"]);
});

test("per-side manual choice and revision are protected including same-value selection", () => {
  let d = auto(); const token = lookupToken(d);
  d = chooseAccount(d, "credit", 2);
  d = applyPair(d, token, pair("A", 3, 4));
  expect([d.debit.account, d.credit.account, d.credit.source]).toEqual([3, 2, "manual"]);
  d = chooseAccount(d, "debit", 3);
  expect(applyPair(d, lookupToken(d), pair("A", 5, 6))).toBe(d);
  const revised = { ...auto(), debit: { ...auto().debit, revision: 1 } };
  expect(applyPair(revised, token, pair("A", 5, 6)).debit).toBe(revised.debit);
});

test("unusable and malformed responses preserve values and source", () => {
  for (const d of [start(), auto(), clearSavedDraft(auto(), auto())]) {
    for (const status of ["none", "unavailable", "legacy_confirmation_required"] as const)
      expect(applyPair(d, lookupToken(d), { ...pair("A"), status })).toBe(d);
    for (const id of [null, 0, -1, NaN, undefined])
      expect(applyPair(d, lookupToken(d), { ...pair("A"), debit_account_id: id as number })).toBe(d);
  }
});

test("old A cannot apply after A B A or split; confirmed legacy protects manual", () => {
  const d = auto(), token = lookupToken(d);
  const aba = editField(editField(d, "item", "B"), "item", "A");
  expect(applyPair(aba, token, pair("A", 3, 4))).toBe(aba);
  const split = switchMode(d).draft;
  expect(applyPair(split, token, pair("A", 3, 4))).toBe(split);
  const manual = chooseAccount(d, "credit", 2);
  const applied = applyPair(manual, lookupToken(manual), { ...pair("A", 3, 4), status: "legacy_confirmation_required" }, true);
  expect([applied.debit.account, applied.credit.account, applied.debit.source]).toEqual([3, 2, "manual"]);
});

test("shared save gate covers debounce, settled, manual, invalid, composing and saving", () => {
  const d = auto(), loading = { token: lookupToken(d), phase: "loading" };
  for (const lookup of [undefined, loading]) expect(inputSaveGate(d, lookup, true, false, false).canSave).toBe(false);
  for (const phase of ["ready", "error", "timeout", "preserved"]) {
    const settled = { ...loading, phase };
    expect(inputSaveGate(d, settled, true, false, false).canSave).toBe(true);
    expect(inputSaveGate(editField(d, "item", "B"), settled, true, false, false).canSave).toBe(false);
    expect(inputSaveGate(d, settled, false, false, false).canSave).toBe(false);
    expect(inputSaveGate(d, settled, true, true, false).canSave).toBe(false);
    expect(inputSaveGate(d, settled, true, false, true).canSave).toBe(false);
  }
  const one = chooseAccount(d, "credit", 2), both = chooseAccount(one, "debit", 1);
  expect(inputSaveGate(one, loading, true, false, false).canSave).toBe(false);
  expect(inputSaveGate(both, loading, true, false, false).canSave).toBe(true);
  expect(inputSaveGate(editField(d, "item", ""), undefined, true, false, false).canSave).toBe(true);
  expect(inputSaveGate(switchMode(d).draft, undefined, true, false, false).canSave).toBe(true);
});

test("mixed manual and recommended same account fails validation", () => {
  let d = chooseAccount(auto(), "credit", 3);
  d = applyPair(d, lookupToken(d), pair("A", 3, 4));
  expect(validateDraft({ ...d, amount: "100" }, new Set([1, 2, 3, 4])).valid).toBe(false);
  expect(d.credit.source).toBe("manual");
});

test("either malformed account ID rejects the entire recommendation atomically", () => {
  const d = auto(), token = lookupToken(d);
  for (const side of ["debit_account_id", "credit_account_id"] as const) {
    for (const id of [null, undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      const response = { ...pair("A", 3, 4), [side]: id } as LastPair;
      expect(applyPair(d, token, response)).toBe(d);
      expect(applyPair(d, token, { ...response, status: "legacy_confirmation_required" }, true)).toBe(d);
    }
  }
});

test("unchanged automatic pair keeps draft identity while equal retained values become automatic", () => {
  const d = auto();
  expect(applyPair(d, lookupToken(d), pair("A"))).toBe(d);
  const retained = clearSavedDraft(d, d);
  const refreshed = applyPair(retained, lookupToken(retained), pair("A"));
  expect([refreshed.debit.account, refreshed.credit.account]).toEqual([1, 2]);
  expect([refreshed.debit.source, refreshed.credit.source]).toEqual(["auto", "auto"]);
  expect(refreshed.revision).toBe(retained.revision + 1);
});

test("confirmed lookup releases only its current valid draft and whitespace needs no recall", () => {
  const d = auto(), confirmed = { token: lookupToken(d), phase: "confirmed" };
  expect(inputSaveGate(d, confirmed, true, false, false)).toEqual({ waitingForRecall: false, canSave: true });
  expect(inputSaveGate(d, confirmed, false, false, false).canSave).toBe(false);
  const newer = { ...d, epoch: d.epoch + 1 };
  expect(inputSaveGate(newer, confirmed, true, false, false)).toEqual({ waitingForRecall: true, canSave: false });
  expect(inputSaveGate(editField(d, "item", " \u0085 "), undefined, true, false, false))
    .toEqual({ waitingForRecall: false, canSave: true });
});
