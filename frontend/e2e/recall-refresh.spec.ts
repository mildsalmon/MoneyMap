import { test, expect, type Page, type Route } from "./test";
import AxeBuilder from "@axe-core/playwright";

const accounts = [
  { id: 101, name: "식비", type: "expense" }, { id: 102, name: "교통", type: "expense" },
  { id: 103, name: "현금", type: "asset" }, { id: 104, name: "카드", type: "liability" },
].map((a, position) => ({ currency: "KRW", parent_id: null, archived: false, is_placeholder: false,
  is_system: false, is_overdraft: false, version: 1, position, ...a }));
const pair = (item_key: string, second = false) => ({ item_key, status: "matched", source_transaction_id: 7,
  debit_account_id: second ? 102 : 101, credit_account_id: second ? 103 : 104, unavailable_reason: null });
const item = (p: Page) => p.getByLabel("아이템 (선택)", { exact: true });
const amount = (p: Page) => p.getByLabel("금액", { exact: true });
const save = (p: Page) => p.getByRole("button", { name: "저장 (Enter)", exact: true });
const retry = (p: Page) => p.getByRole("button", { name: "계정 추천 다시 조회", exact: true });
const radio = (p: Page, side: string, name: string) => p.getByRole("group", { name: side + " 계정", exact: true }).getByRole("radio", { name, exact: true });
const status = (p: Page) => p.locator(".txn-recall");

test.beforeEach(async ({ page }) => {
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: [] }));
  await page.route("**/api/transactions", r => r.request().method() === "GET" ? r.fulfill({ json: [] }) : r.fulfill({ status: 201, json: { id: 700 } }));
  await page.route("**/api/transaction-input/recent?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/transaction-input/last-pair?*", r => {
    const key = new URL(r.request().url()).searchParams.get("item")!;
    return r.fulfill({ json: pair(key, key === "B") });
  });
  await page.goto("/transactions/new");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await expect(radio(page, "차변", "비용 > 식비")).toBeAttached();
});

test("successive recalls and next saved draft refresh, current manual side stays protected", async ({ page }) => {
  await item(page).fill("A");
  await expect(radio(page, "대변", "부채 > 카드")).toBeChecked();
  await item(page).fill("B");
  await expect(radio(page, "차변", "비용 > 교통")).toBeChecked();
  await expect(radio(page, "대변", "자산 > 현금")).toBeChecked();
  await radio(page, "대변", "자산 > 현금").click();
  await item(page).fill("A");
  await expect(radio(page, "차변", "비용 > 식비")).toBeChecked();
  await expect(radio(page, "대변", "자산 > 현금")).toBeChecked();
  await expect(status(page)).toContainText("직접 선택한 대변은 유지");
  await amount(page).fill("100");
  await save(page).click();
  await expect(amount(page)).toHaveValue("");
  await item(page).fill("B");
  await expect(radio(page, "차변", "비용 > 교통")).toBeChecked();
});

for (const unchanged of ["debit", "credit"] as const) {
  test(`shared ${unchanged} stays automatic without a manual-preservation claim`, async ({ page }) => {
    await item(page).fill("A");
    await expect(status(page)).toHaveText("마지막으로 저장한 계정을 선택했습니다.");
    await page.route("**/api/transaction-input/last-pair?*", r => {
      const key = new URL(r.request().url()).searchParams.get("item")!;
      return r.fulfill({ json: { ...pair(key, true), ...(key === "B" ? { [unchanged + "_account_id"]: unchanged === "debit" ? 101 : 104 } : {}) } });
    });
    await item(page).fill("B");
    await expect(status(page)).toContainText(`기존 ${unchanged === "debit" ? "차변" : "대변"}은 유지했습니다.`);
    await expect(status(page)).not.toContainText("직접 선택");
    await expect(page.locator(".txn-selected").nth(unchanged === "debit" ? 0 : 1)).toContainText("자동 선택");
    await item(page).fill("C");
    await expect(radio(page, "차변", "비용 > 교통")).toBeChecked();
    await expect(radio(page, "대변", "자산 > 현금")).toBeChecked();
  });
}

test("debounce and pending block both save buttons and direct submit; both manual release gate", async ({ page }) => {
  await item(page).fill("A"); await amount(page).fill("100");
  await expect(save(page)).toBeEnabled();
  let posts = 0; let held: Route | undefined;
  await page.route("**/api/transactions", r => { posts++; return r.fulfill({ status: 201, json: { id: 700 } }); });
  await page.route("**/api/transaction-input/last-pair?*", r => { held = r; });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await item(page).fill("B");
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "저장 후 대시보드" })).toBeDisabled();
  await expect(page.locator("#transaction-save-hint")).toHaveText("계정 추천 확인 후 저장할 수 있습니다.");
  await page.locator("form").dispatchEvent("submit");
  expect(posts).toBe(0);
  await page.clock.runFor(250);
  await expect.poll(() => !!held).toBe(true);
  await amount(page).press("Enter"); expect(posts).toBe(0);
  await radio(page, "대변", "부채 > 카드").click();
  await expect(save(page)).toBeDisabled();
  await radio(page, "차변", "비용 > 식비").click();
  await expect(save(page)).toBeEnabled();
  await save(page).click(); await expect.poll(() => posts).toBe(1);
});

test("timeout settles without clearing input, retry ignores expired response and never posts", async ({ page }) => {
  await item(page).fill("A"); await amount(page).fill("100");
  await expect(save(page)).toBeEnabled();
  const held: Route[] = []; let posts = 0;
  await page.route("**/api/transactions", r => { posts++; return r.abort(); });
  await page.route("**/api/transaction-input/last-pair?*", r => { held.push(r); });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await item(page).fill("B");
  await page.clock.runFor(200);
  await expect.poll(() => held.length).toBe(1);
  await page.clock.runFor(4999);
  await expect(save(page)).toBeDisabled();
  await page.clock.runFor(1);
  await expect(status(page)).toContainText("시간이 초과");
  await expect(save(page)).toBeEnabled();
  await expect(radio(page, "대변", "부채 > 카드")).toBeChecked();
  await retry(page).click();
  await expect(save(page)).toBeDisabled();
  await page.clock.runFor(200);
  await expect.poll(() => held.length).toBe(2);
  await held[0].fulfill({ json: pair("B", false) }).catch(() => {});
  await expect(save(page)).toBeDisabled();
  await held[1].fulfill({ json: pair("B", true) });
  await expect(radio(page, "차변", "비용 > 교통")).toBeChecked();
  await expect(save(page)).toBeEnabled();
  await expect(amount(page)).toHaveValue("100");
  expect(posts).toBe(0);
});

test("network failure keeps existing values and keyboard retry works", async ({ page }) => {
  await item(page).fill("A"); await amount(page).fill("100");
  await expect(save(page)).toBeEnabled();
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ status: 503, json: { detail: "failed" } }));
  await item(page).fill("B");
  await expect(retry(page)).toBeVisible();
  await expect(status(page)).toContainText("현재 선택은 유지");
  await expect(save(page)).toBeEnabled();
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: pair("B", true) }));
  await retry(page).focus(); await page.keyboard.press("Enter");
  await expect(radio(page, "차변", "비용 > 교통")).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).include(".txn-page").analyze()).violations).toEqual([]);
});

test("undo invalidates an in-flight recommendation without leaving the save gate pending", async ({ page }) => {
  await item(page).fill("A"); await amount(page).fill("100");
  await expect(save(page)).toBeEnabled(); await save(page).click();
  await expect(amount(page)).toHaveValue("");
  await expect(status(page)).toContainText("마지막으로 저장한 계정을 선택");
  let held: Route | undefined;
  await page.route("**/api/transaction-input/last-pair?*", r => { held = r; });
  await page.route("**/api/transactions/700", r => r.fulfill({ json: { deleted: 700 } }));
  await item(page).fill("B"); await amount(page).fill("200");
  await expect.poll(() => !!held).toBe(true);
  await expect(save(page)).toBeDisabled();
  await page.locator(".toast").getByRole("button", { name: "실행취소" }).click();
  await expect(status(page)).toContainText("현재 선택한 계정은 유지");
  await held!.fulfill({ json: pair("B", true) }).catch(() => {});
  await expect(radio(page, "대변", "부채 > 카드")).toBeChecked();
  await expect(save(page)).toBeEnabled();
  // Changing the item explicitly also releases undo preservation.
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: pair("C", true) }));
  await item(page).fill("C");
  await expect(radio(page, "대변", "자산 > 현금")).toBeChecked();
});

for (const delayed of [false, true]) {
  test(`undo protects remounted draft when DELETE completes ${delayed ? "after" : "before request from"} navigation`, async ({ page }) => {
    await item(page).fill("A"); await amount(page).fill("100");
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(page.locator(".toast")).toBeVisible();
    let undo: Route | undefined; let deleted = false;
    await page.route("**/api/transactions/700", r => { undo = r; });
    if (delayed) {
      await page.locator(".toast").getByRole("button", { name: "실행취소" }).click();
      await expect.poll(() => !!undo).toBe(true);
    }
    await page.locator(".side nav").getByRole("button", { name: "거래 내역", exact: true }).click();
    await page.locator(".side nav").getByRole("button", { name: "거래 입력", exact: true }).click();
    await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: pair("A", deleted) }));
    await item(page).fill("A"); await amount(page).fill("200");
    await expect(radio(page, "대변", "부채 > 카드")).toBeChecked();
    if (!delayed) {
      await page.locator(".toast").getByRole("button", { name: "실행취소" }).click();
      await expect.poll(() => !!undo).toBe(true);
    }
    deleted = true;
    await undo!.fulfill({ json: { deleted: 700 } });
    await expect(status(page)).toContainText("현재 선택한 계정은 유지");
    await expect(radio(page, "대변", "부채 > 카드")).toBeChecked();
    await expect(page.locator(".txn-selected").last()).toContainText("자동 선택");
    await expect(save(page)).toBeEnabled();
    await retry(page).click();
    await expect(radio(page, "대변", "자산 > 현금")).toBeChecked();
    await expect(amount(page)).toHaveValue("200");
  });
}
