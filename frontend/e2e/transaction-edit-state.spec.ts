import { expect, test } from "./test";
import { makeDetail } from "./transactionEditFixtures";
import { classifyEditResult, draftIdentity, editBody, editDraft, historyReturn, originalRows } from "../src/views/transactionEditState";
import { amountInput, chooseAccount, editField, switchMode, validateDraft } from "../src/views/transactionInputState";
import { isTransactionDetail } from "../src/api/transactionEditResponse";

const uuid = "11111111-2222-3333-4444-555555555555";
test("equal formatted amounts are not dirty and split mode keeps identities", () => {
  const original = makeDetail({ postings: makeDetail().postings.map(p => ({ ...p, amount: p.amount * 10 })) });
  const draft = editDraft(original);
  expect(draft.amount).toBe("1,000");
  expect(draftIdentity({ ...draft, amount: "1000" })).toBe(draftIdentity(draft));
  expect(draftIdentity(editField(draft, "amount", amountInput("1000")))).toBe(draftIdentity(draft));
  for (const value of ["", "100x", "1001", "9007199254740992"]) {
    expect(draftIdentity({ ...draft, amount: value })).not.toBe(draftIdentity(draft));
  }
  const split = switchMode(draft).draft;
  const reformatted = { ...split, rows: split.rows.map((r, i) => i ? r : { ...r, amount: "1000" }) };
  expect(draftIdentity(reformatted)).toBe(draftIdentity(split));
  expect(validateDraft(reformatted, new Set([101, 102]), originalRows(original)).valid).toBe(true);
  const basic = switchMode(reformatted);
  expect(basic.error).toBeUndefined();
  expect(draftIdentity(basic.draft)).toBe(draftIdentity(draft));
  expect(draftIdentity({ ...split, rows: split.rows.map(r => ({ ...r, postingId: undefined })) })).not.toBe(draftIdentity(split));
  expect(switchMode({ ...split, rows: split.rows.map((r, i) => i ? r : { ...r, amount: "invalid" }) }).error).toBeTruthy();
});
test("hydration, mode round trip and account replacement preserve posting identity", () => {
  const original = makeDetail(), draft = editDraft(original);
  expect(draft.mode).toBe("basic"); expect(draft.memo).toBe(original.memo);
  expect(draftIdentity(switchMode(switchMode(draft).draft).draft)).toBe(draftIdentity(draft));
  const changed = chooseAccount(editField(draft, "item", "새 내역"), "debit", 104);
  const body = editBody(original, changed, validateDraft(changed, new Set([101, 102, 104]), originalRows(original)), uuid);
  expect(body.postings?.[0]).toEqual({ posting_id: 11, account_id: 104, amount: 100 });
  expect(Object.keys(body).sort()).toEqual(["date", "description", "expected_version", "memo", "postings", "request_id", "tags"]);
  expect(body.expected_version).toBe(original.version);
});
test("legacy zero and unavailable original rows survive, but not on a new row", () => {
  const original = makeDetail({ postings: makeDetail().postings.map(p => ({ ...p, amount: 0 })) });
  const draft = editDraft(original);
  expect(draft.mode).toBe("split");
  expect(validateDraft(draft, new Set(), originalRows(original)).valid).toBe(true);
  const replaced = { ...draft, rows: draft.rows.map((r, i) => i ? r : { ...r, postingId: undefined }) };
  expect(validateDraft(replaced, new Set([101, 102]), originalRows(original)).valid).toBe(false);
  expect(editDraft(makeDetail({ postings: [...makeDetail().postings, { posting_id: 13, account_id: 104, amount: 0, currency: "KRW" }] })).rows).toHaveLength(3);
});
test("opening command never submits client system or split rows", () => {
  const original = makeDetail({ kind: "opening", opening_system_id: 105,
    postings: [{ posting_id: 11, account_id: 102, amount: 100, currency: "KRW" }, { posting_id: 12, account_id: 105, amount: -100, currency: "KRW" }] });
  const draft = editDraft(original), negative = { ...draft, debit: draft.credit, credit: draft.debit };
  const command = editBody(original, negative, validateDraft(negative, new Set([102]), originalRows(original)), uuid);
  expect(command.opening).toEqual({ account_id: 102, signed_amount: -100 }); expect(command.postings).toBeUndefined();
});
test("dirty check ignores UI epochs but notices all user fields and can revert", () => {
  const draft = editDraft(makeDetail());
  expect(draftIdentity({ ...draft, epoch: 40, revision: 90 })).toBe(draftIdentity(draft));
  for (const field of ["date", "item", "memo", "amount"] as const) expect(draftIdentity(editField(draft, field, "different"))).not.toBe(draftIdentity(draft));
  expect(draftIdentity(editField(editField(draft, "memo", "다름"), "memo", draft.memo))).toBe(draftIdentity(draft));
});
test("receipt results distinguish applied, terminal failure, later edits/deletion and malformed bodies", () => {
  const original = makeDetail(), draft = editDraft(original);
  const submitted = editBody(original, draft, validateDraft(draft, new Set([101, 102])), uuid);
  const result = { request_id: uuid, outcome: "applied" as const, result_version: original.version, transaction: original };
  expect(classifyEditResult(result, 71, submitted)).toBe("saved");
  expect(classifyEditResult({ ...result, transaction: { ...original, version: "c".repeat(32) } }, 71, submitted)).toBe("conflict");
  expect(classifyEditResult({ ...result, transaction: null }, 71, submitted)).toBe("conflict");
  expect(classifyEditResult({ ...result, outcome: "not_applied", result_version: null }, 71, submitted)).toBe("retry");
  for (const patch of [{ request_id: "another" }, { transaction: {} }, { transaction: { ...original, postings: [{}] } }, { result_version: "wrong" }]) {
    expect(classifyEditResult({ ...result, ...patch } as typeof result, 71, submitted)).toBe("invalid");
  }
  expect(classifyEditResult({ ...result, outcome: "not_applied" }, 71, submitted)).toBe("invalid");
});
test("detail validation refuses malformed IDs, amounts, fields, currency and protected pair", () => {
  const original = makeDetail();
  expect(isTransactionDetail(original, 71)).toBe(true);
  for (const patch of [{ id: 72 }, { date: null }, { tags: [1] }, { editable: undefined }, { postings: [original.postings[0], original.postings[0]] },
    { postings: original.postings.map(p => ({ ...p, amount: "100" })) }, { kind: "opening", opening_system_id: 999 },
    { postings: original.postings.map(p => ({ ...p, currency: "USD" })) }]) expect(isTransactionDetail({ ...original, ...patch }, 71)).toBe(false);
});
test("return state is bounded to list UI state, not financial drafts", () => {
  expect(historyReturn({ tagFilter: "데이트", scrollY: -100, scrollLeft: Infinity, focusId: "71", memo: "secret" })).toEqual({ tagFilter: "데이트", scrollY: 0, scrollLeft: 0, focusId: null });
  expect(historyReturn(undefined)).toEqual({ tagFilter: "", scrollY: 0, scrollLeft: 0, focusId: null });
});
