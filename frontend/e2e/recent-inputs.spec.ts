import { test, expect, type Page, type Route } from "./test";
import AxeBuilder from "@axe-core/playwright";

const accounts = [
  { id: 101, name: "식비", type: "expense" }, { id: 102, name: "현금", type: "asset" },
].map((a, position) => ({ currency: "KRW", parent_id: null, archived: false, is_placeholder: false,
  is_system: false, is_overdraft: false, version: 1, position, ...a }));
const record = (id: number) => ({ id, date: "2026-10-03", description: `입력 ${id}`, amount: 100,
  posting_count: 2, debit_account_id: 101, credit_account_id: 102 });
const data = Array.from({ length: 12 }, (_, i) => record(12 - i));
const rows = (page: Page) => page.locator(".txn-recent tbody tr");
const more = (page: Page) => page.getByRole("button", { name: "최근 입력 더보기", exact: true });
const retry = (page: Page) => page.getByRole("button", { name: "최근 입력 다시 불러오기", exact: true });
const cursor = (route: Route) => Number(new URL(route.request().url()).searchParams.get("before_id") ?? Infinity);
const reply = (route: Route, entries = data) => route.fulfill({ json: entries.filter(row => row.id < cursor(route)).slice(0, 6) });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: [] }));
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: {
    item_key: new URL(r.request().url()).searchParams.get("item"), status: "matched", source_transaction_id: 12,
    debit_account_id: 101, credit_account_id: 102, unavailable_reason: null,
  } }));
  await page.route("**/api/transaction-input/recent?*", r => reply(r));
});

test("five at a time, cursor paging, old item reuse, keyboard and end announcement", async ({ page }) => {
  await page.goto("/transactions/new");
  await expect(rows(page)).toHaveCount(5);
  await page.getByLabel("금액", { exact: true }).fill("123");
  await page.getByLabel("메모 (선택)", { exact: true }).fill("유지할 메모");
  await more(page).focus(); await page.keyboard.press("Enter");
  await expect(rows(page)).toHaveCount(10);
  await expect(rows(page).first()).toContainText("입력 12");
  await page.getByRole("button", { name: "입력 3", exact: true }).click();
  await expect(page.getByLabel("아이템 (선택)", { exact: true })).toHaveValue("입력 3");
  await expect(page.getByLabel("금액", { exact: true })).toHaveValue("123");
  await expect(page.getByLabel("메모 (선택)", { exact: true })).toHaveValue("유지할 메모");
  await expect(page.getByRole("radio", { name: "자산 > 현금", exact: true }).last()).toBeChecked();
  await more(page).click();
  await expect(rows(page)).toHaveCount(12);
  await expect(more(page)).toHaveCount(0);
  await expect(page.locator(".txn-recent [role=status]")).toHaveText("12건 표시 · 마지막 입력입니다.");
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).include(".txn-recent").analyze()).violations).toEqual([]);
});

test("pending page retains rows, blocks double requests, failure retries same cursor", async ({ page }) => {
  await page.goto("/transactions/new"); await expect(rows(page)).toHaveCount(5);
  let held: Route | undefined; const calls: number[] = [];
  await page.route("**/api/transaction-input/recent?*", r => { calls.push(cursor(r)); held = r; });
  await more(page).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => calls.length).toBe(1); expect(calls).toEqual([8]);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByRole("button", { name: "불러오는 중…", exact: true })).toBeDisabled();
  await held!.fulfill({ status: 503, json: { detail: "unavailable" } });
  await expect(retry(page)).toBeVisible(); await expect(rows(page)).toHaveCount(5);
  await page.route("**/api/transaction-input/recent?*", r => { calls.push(cursor(r)); return reply(r); });
  await retry(page).click(); await expect(rows(page)).toHaveCount(10);
  expect(calls).toEqual([8, 8]);
});

for (const count of [0, 5]) {
  test(`initial failure can retry an exact ${count}-row final page`, async ({ page }) => {
    await page.route("**/api/transaction-input/recent?*", r => r.abort());
    await page.goto("/transactions/new"); await expect(retry(page)).toBeVisible();
    await page.route("**/api/transaction-input/recent?*", r => r.fulfill({ json: data.slice(0, count) }));
    await retry(page).click(); await expect(rows(page)).toHaveCount(count);
    await expect(page.locator(".txn-recent [role=status]")).toHaveText(count ? "5건 표시 · 마지막 입력입니다." : "저장한 거래가 여기에 표시됩니다.");
    await expect(more(page)).toHaveCount(0);
  });
}

test("save and undo reset the list; old page cannot append after refresh", async ({ page }) => {
  await page.goto("/transactions/new"); await expect(rows(page)).toHaveCount(5);
  let held: Route | undefined; let saved = false;
  await page.route("**/api/transaction-input/recent?*", r => {
    if (Number.isFinite(cursor(r))) { held = r; return; }
    return reply(r, saved ? [record(13), ...data] : data);
  });
  await more(page).click(); await expect.poll(() => !!held).toBe(true);
  await page.route("**/api/transactions", r => { saved = true; return r.fulfill({ status: 201, json: { id: 13 } }); });
  await page.getByLabel("아이템 (선택)", { exact: true }).fill("새 입력");
  await page.getByLabel("금액", { exact: true }).fill("100");
  await page.getByRole("button", { name: "저장 (Enter)", exact: true }).click();
  await expect(rows(page).first()).toContainText("입력 13");
  await held!.fulfill({ json: data.slice(5, 11) }).catch(() => {});
  await expect(rows(page)).toHaveCount(5);
  await page.route("**/api/transactions/13", r => { saved = false; return r.fulfill({ json: { deleted: 13 } }); });
  await page.locator(".toast").getByRole("button", { name: "실행취소" }).click();
  await expect(rows(page).first()).toContainText("입력 12"); await expect(rows(page)).toHaveCount(5);
});
