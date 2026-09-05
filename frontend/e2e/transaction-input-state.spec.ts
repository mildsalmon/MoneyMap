import { test, expect } from "./test";
import { newDraft, editField, chooseAccount, applyPair, lookupToken, switchMode, clearSavedDraft, validateDraft, amountInput, amountValue, itemKey } from "../src/views/transactionInputState";
import type { LastPair } from "../src/api/types";
const pair: LastPair = { item_key: "점심", status: "matched", source_transaction_id: 9, debit_account_id: 1, credit_account_id: 2, unavailable_reason: null };
const ready = () => chooseAccount(chooseAccount(editField(editField(newDraft("2026-09-05"), "item", "점심"), "amount", "100"), "debit", 1), "credit", 2);

test("late lookup protects each manual side and discards other item/mode epochs", () => {
  let d = editField(newDraft("2026-09-05"), "item", "점심"); const token = lookupToken(d);
  d = chooseAccount(d, "debit", 3); d = applyPair(d, token, pair);
  expect(d.debit.account).toBe(3); expect(d.credit.account).toBe(2);
  expect(applyPair(editField(d, "item", "저녁"), token, pair).credit.account).toBeNull();
  expect(applyPair(switchMode(d).draft, token, pair).mode).toBe("split");
  expect(applyPair(d, token, { ...pair, item_key: "저녁" })).toEqual(d);
});
test("manual choices survive item changes, saved choices unlock and next item clears", () => {
  const d = ready(); expect(editField(d, "item", "저녁").debit.account).toBe(1);
  const saved = clearSavedDraft(editField(d,"memo","다음 줄\n메모"), editField(d,"memo","다음 줄\n메모"));
  expect(saved.memo).toBe(""); expect(saved.amount).toBe(""); expect(saved.debit.source).toBe("retained");
  expect(editField(saved,"item","저녁").debit.account).toBeNull();
});
test("pending save preserves later edits and invalidates earlier responses", () => {
  const submitted = ready(); const changed = editField(submitted,"memo","다음 거래");
  const saved = clearSavedDraft(changed, submitted);
  expect(saved.memo).toBe("다음 거래"); expect(saved.amount).toBe("100"); expect(saved.epoch).toBeGreaterThan(changed.epoch);
});
test("split mode is lossless and rejects extra, unequal and partially filled rows", () => {
  const d = editField(ready(), "memo", "공유 메모"); const split = switchMode(d).draft;
  expect(switchMode(split).draft.memo).toBe("공유 메모");
  for (const rows of [[...split.rows, { id:3, account:null, amount:"", debit:true }], split.rows.map((r,i) => i ? { ...r, amount:"90" } : r)]) {
    const written = { ...split, rows }; expect(switchMode(written).draft).toBe(written); expect(switchMode(written).error).toBeTruthy();
  }
  for (const row of [{id:3,account:1,amount:"",debit:true},{id:3,account:null,amount:"20",debit:true},{id:3,account:1,amount:"0",debit:true},{id:3,account:1,amount:"x",debit:true}]) {
    const v = validateDraft({ ...split, rows:[...split.rows,row] },new Set([1,2])); expect(v.valid).toBe(false); expect(v.postings).toEqual([]); expect(v.errors[3]).toBeTruthy();
  }
  expect(validateDraft({...split, rows:[...split.rows,{id:3,account:null,amount:"",debit:true}]},new Set([1,2])).postings).toHaveLength(2);
});
test("legacy confirmation is explicit, unavailable clears only automatic selections", () => {
  let d = editField(newDraft("2026-09-05"),"item","점심"); const token=lookupToken(d);
  const legacy:LastPair={...pair,status:"legacy_confirmation_required"};
  expect(applyPair(d,token,legacy).debit.account).toBeNull();
  d=applyPair(d,token,legacy,true); expect(d.debit.source).toBe("manual");
  expect(applyPair(d,token,{...pair,status:"unavailable",debit_account_id:null,credit_account_id:null}).debit.account).toBe(1);
});
test("amount validation preserves invalid or zero entries and excludes stale accounts", () => {
  expect(amountInput("0")).toBe("0"); expect(amountInput("12x")).toBe("12x"); expect(amountValue("9007199254740992")).toBeNaN();
  expect(validateDraft(ready(),new Set([1])).valid).toBe(false);
  expect(validateDraft(chooseAccount(ready(),"credit",1),new Set([1,2])).valid).toBe(false);
});

test("item whitespace identity matches backend for BOM, NEL, C0 and NFC", () => {
  for (const item of ["\ufeff점심\u0085", "\u001c점심\u001f", " 점심 ".normalize("NFD")]) expect(itemKey(item)).toBe("점심");
});
