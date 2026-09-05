import { expect, test, type Page } from "./test";

const accounts = [
  { id: 101, name: "식비", type: "expense", is_placeholder: true },
  { id: 102, name: "기타", type: "expense", parent_id: 101 },
  { id: 103, name: "현금", type: "asset" },
  { id: 104, name: "카드", type: "liability" },
  { id: 201, name: "교통", type: "expense", is_placeholder: true },
  { id: 202, name: "기타", type: "expense", parent_id: 201 },
].map((a, position) => ({ parent_id: null, currency: "KRW", archived: false, is_placeholder: false, is_system: false, is_overdraft: false, version: 1, position, ...a }));
const pair = { item_key: "점심", status: "matched", source_transaction_id: 9, debit_account_id: 102, credit_account_id: 104, unavailable_reason: null };
const item = (page: Page) => page.getByLabel("아이템 (선택)", { exact: true });
const amount = (page: Page) => page.getByLabel("금액", { exact: true });
const group = (page: Page, side = "차변") => page.getByRole("group", { name: `${side} 계정`, exact: true });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await page.route("**/api/transaction-input/recent?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: { ...pair, item_key: new URL(r.request().url()).searchParams.get("item") } }));
  await page.goto("/transactions/new");
  await expect(group(page).getByRole("radio", { name: "비용 > 식비 > 기타", exact: true })).toBeAttached();
});

test("clicking an automatic selection locks only that side for the next item", async ({ page }) => {
  await item(page).fill("점심");
  const debit = group(page).getByRole("radio", { name: "비용 > 식비 > 기타", exact: true });
  await expect(debit).toBeChecked();
  await debit.click(); // check() would skip the already checked control.
  await expect(page.locator(".txn-selected").first()).toContainText("직접 선택");
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: { ...pair, item_key: "새 아이템", status: "none", debit_account_id: null, credit_account_id: null } }));
  await item(page).fill("새 아이템");
  await expect(page.locator(".txn-recall")).toContainText("처음 입력");
  await expect(debit).toBeChecked();
  await expect(group(page, "대변").getByRole("radio", { name: "부채 > 카드", exact: true })).not.toBeChecked();
});

for (const balance of [0, 500, "error"] as const) {
  test(`debt fill preserves the draft and permits retry for ${balance}`, async ({ page }) => {
    await group(page).getByRole("radio", { name: "부채 > 카드", exact: true }).check();
    await group(page, "대변").getByRole("radio", { name: "자산 > 현금", exact: true }).check();
    await amount(page).fill("50");
    await page.route("**/api/balances?*", r => balance === "error"
      ? r.fulfill({ status: 503, json: { detail: "조회 실패" } })
      : r.fulfill({ json: { accounts: [{ account_id: 104, balance }] } }));
    const fill = page.getByRole("button", { name: "오늘 부채 잔액으로 채우기", exact: true });
    await fill.click();
    await expect(page.getByText(balance === "error" ? "잔액을 불러오지 못했습니다. 다시 시도하거나 금액을 입력하세요." : "오늘 갚을 부채 잔액이 없습니다. 입력한 금액은 유지했습니다.", { exact: true })).toBeVisible();
    await expect(amount(page)).toHaveValue("50");
    await expect(fill).toBeEnabled();
    await page.route("**/api/balances?*", r => r.fulfill({ json: { accounts: [{ account_id: 104, balance: -9000 }] } }));
    await fill.click();
    await expect(amount(page)).toHaveValue("9,000");
  });
}

test("legacy confirmation and collapsed split rows distinguish duplicate account names", async ({ page }) => {
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: { ...pair, status: "legacy_confirmation_required", credit_account_id: 202 } }));
  await item(page).fill("점심");
  await expect(page.locator(".txn-recall")).toContainText("비용 > 식비 > 기타 → 비용 > 교통 > 기타");
  await page.getByRole("button", { name: "이전 기록 확인 후 불러오기", exact: true }).click();
  await page.getByRole("button", { name: "분할 입력", exact: true }).click();
  await expect(page.locator("#split-account-1")).toContainText("비용 > 식비 > 기타");
  await expect(page.locator("#split-account-2")).toContainText("비용 > 교통 > 기타");
  await expect(page.locator(".split-picker")).toHaveCount(0);
});

test("memo uses the same font family as the item input", async ({ page }) => {
  const expected = await item(page).evaluate(e => getComputedStyle(e).fontFamily);
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveCSS("font-family", expected);
});
