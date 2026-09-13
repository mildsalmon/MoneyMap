import { test, expect } from "@playwright/test";
import { insertOrder, overlayOrder, projectBlocks, scopeKey, siblings, swapOrder, validReorderResponse } from "../src/views/accountOrdering";
import type { Account } from "../src/api/types";

function account(id: number, parent_id: number | null = null, extra: Partial<Account> = {}): Account {
  return { id, parent_id, name: `a${id}`, type: "expense", currency: "KRW", archived: false, is_system: false,
    is_placeholder: false, is_overdraft: false, include_in_cash: false, position: id, version: 1, ...extra };
}
test("scope projection keeps subtree and preserved slots", () => {
  const list = [account(1), account(2, 1), account(3, 2), account(4), account(5, null, { archived: true }), account(6, null, { is_system: true })];
  expect(projectBlocks(list, list[0]).map(b => b.rowIds)).toEqual([[1, 2, 3], [4]]);
  expect(projectBlocks(list, list[1]).map(b => b.rowIds)).toEqual([[2, 3]]);
  expect(siblings([], list[0])).toEqual([]);
  expect(scopeKey(list[0])).toBe("expense:root");
  expect(scopeKey(list[1])).toBe("expense:1");
  const overlay = overlayOrder(list, list[0], [4, 1]);
  expect(overlay.map(a => a.position)).toEqual([4, 2, 3, 1, 5, 6]);
  expect(list[0].position).toBe(1);
});
test("moves reject boundaries, unknown ids and self targets", () => {
  expect(swapOrder([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
  expect(swapOrder([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
  expect(swapOrder([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
  expect(insertOrder([1, 2, 3], 1, 3, true)).toEqual([2, 3, 1]);
  expect(insertOrder([1, 2, 3], 3, 1, false)).toEqual([3, 1, 2]);
  expect(insertOrder([1, 2, 3], 1, 9, true)).toEqual([1, 2, 3]);
  expect(insertOrder([1, 2, 3], 1, 1, true)).toEqual([1, 2, 3]);
});
test("untrusted success payload must match full account snapshot", () => {
  const previous = [account(1), account(3)];
  const result = { accounts: [account(3, null, { position: 1, version: 2 }), account(1, null, { position: 3, version: 2 })], effects: { changed_account_ids: [3, 1] } };
  expect(validReorderResponse(result, previous, [3, 1])).toBeTruthy();
  expect(validReorderResponse({ ...result, effects: { changed_account_ids: [] } }, previous, [3, 1])).toBeFalsy();
  expect(validReorderResponse({ ...result, accounts: [{ ...result.accounts[0], name: "unexpected" }, result.accounts[1]] }, previous, [3, 1])).toBeFalsy();
});
