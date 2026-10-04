import { expect, test, type Page } from "./test";
import { editAccounts } from "./transactionEditFixtures";
import type { Rule, RuleBody } from "../src/api/types";

const initial: Rule = { id: 71, scenario_id: 1, description: "월급 규칙", from_account_id: 102, to_account_id: 101,
  amount: { amount: 123000, currency: "KRW" }, schedule: { spec: "weekly:wed" },
  start_date: "2024-01-10", end_date: "2028-12-31", last_materialized: "2026-09-30", edit_token: '"old"' };
const form = (page: Page) => page.getByRole("form", { name: "실제 반복 규칙 수정" });
const save = (page: Page) => page.getByRole("button", { name: "규칙 저장", exact: true });

async function setup(page: Page) {
  const state = { rule: structuredClone(initial), writes: 0, body: undefined as RuleBody | undefined };
  await page.route("**/api/accounts", r => r.fulfill({ json: editAccounts }));
  await page.route("**/api/rules?*", r => r.fulfill({ json: [state.rule] }));
  await page.route("**/api/rules/71", r => {
    state.writes++; state.body = r.request().postDataJSON();
    expect(r.request().headers()["if-match"]).toBe(state.rule.edit_token);
    const body = state.body!;
    state.rule = { ...state.rule, ...body, description: body.description ?? "", end_date: body.end_date ?? null,
      amount: { amount: body.amount, currency: "KRW" }, schedule: { spec: body.schedule }, edit_token: '"new"' };
    return r.fulfill({ json: state.rule });
  });
  await page.goto("/rules");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await page.getByRole("button", { name: "수정", exact: true }).click();
  await expect(form(page)).toBeVisible();
  return state;
}

test("prefills weekly dates, edits amount without resetting schedule, and restores focus", async ({ page }) => {
  const state = await setup(page);
  await expect(form(page).getByLabel("내역", { exact: true })).toBeFocused();
  await expect(form(page).getByLabel("반복 주기")).toHaveValue("weekly");
  await expect(form(page).getByLabel("실행 요일")).toHaveValue("wed");
  await expect(form(page).getByLabel("규칙 시작일")).toHaveValue("2024-01-10");
  await expect(form(page).getByLabel("규칙 종료일")).toHaveValue("2028-12-31");
  await form(page).getByLabel("금액/회 (원)").fill("456000");
  await save(page).click();
  await expect(form(page)).toHaveCount(0);
  expect(state.body).toMatchObject({ amount: 456000, schedule: "weekly:wed", start_date: "2024-01-10", end_date: "2028-12-31" });
  await expect(page.getByRole("button", { name: "수정", exact: true })).toBeFocused();
});

test("cancel discards draft only and preserves original", async ({ page }) => {
  const state = await setup(page);
  await form(page).getByLabel("내역", { exact: true }).fill("취소할 내용");
  page.on("dialog", d => d.accept());
  await form(page).getByRole("button", { name: "취소", exact: true }).click();
  await expect(form(page)).toHaveCount(0);
  expect(state.writes).toBe(0);
  await expect(page.getByRole("button", { name: "수정", exact: true })).toBeFocused();
});

test("monthly 31 and cleared end date are submitted on mobile without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await setup(page);
  await form(page).getByLabel("반복 주기").selectOption("monthly");
  await form(page).getByLabel("실행일", { exact: true }).selectOption("31");
  await form(page).getByLabel("규칙 종료일").fill("");
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width);
  await save(page).click();
  await expect(form(page)).toHaveCount(0);
  expect(state.body).toMatchObject({ schedule: "monthly:31", end_date: null });
  const target = await page.getByRole("button", { name: "수정", exact: true }).boundingBox();
  expect(target!.height).toBeGreaterThanOrEqual(44);
});

for (const error of [
  { status: 503, code: "database_busy", message: "잠시 후 재시도" },
  { status: 404, code: "account_not_found", message: "계정이 없습니다" },
]) test(`${error.code} preserves draft and allows explicit retry`, async ({ page }) => {
  const state = await setup(page);
  await page.route("**/api/rules/71", async r => { await r.fulfill({ status: error.status, json: { detail: error } }); });
  await form(page).getByLabel("금액/회 (원)").fill("222000");
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(form(page).getByLabel("금액/회 (원)")).toHaveValue("222000");
  await expect(save(page)).toBeEnabled();
  await page.unroute("**/api/rules/71");
  await page.route("**/api/rules/71", r => { state.writes++; return r.fulfill({ json: { ...state.rule, amount: { amount: 222000, currency: "KRW" }, edit_token: '"new"' } }); });
  await save(page).click();
  await expect(form(page)).toHaveCount(0);
  expect(state.writes).toBe(1);
});

test("conflict keeps draft until latest is explicitly accepted", async ({ page }) => {
  const state = await setup(page);
  await form(page).getByLabel("금액/회 (원)").fill("333000");
  state.rule = { ...state.rule, amount: { amount: 200000, currency: "KRW" }, edit_token: '"other"' };
  await page.route("**/api/rules/71", r => r.fulfill({ status: 409, json: { detail: { code: "rule_edit_conflict", message: "충돌" } } }));
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  await page.getByRole("button", { name: "작성 내용을 유지하고 최신 내용 확인" }).click();
  await expect(page.locator(".rule-latest")).toContainText("200,000");
  await expect(form(page).getByLabel("금액/회 (원)")).toHaveValue("333000");
  await page.getByRole("button", { name: "이 최신 규칙을 기준으로 계속 수정" }).click();
  await expect(form(page).getByLabel("내역", { exact: true })).toBeFocused();
  await expect(save(page)).toBeEnabled();
  await page.route("**/api/rules/71", r => {
    expect(r.request().headers()["if-match"]).toBe('"other"');
    expect(r.request().postDataJSON().amount).toBe(333000);
    return r.fulfill({ json: { ...state.rule, amount: { amount: 333000, currency: "KRW" }, edit_token: '"saved"' } });
  });
  await save(page).click();
  await expect(form(page)).toHaveCount(0);
});

test("lost save response is reconciled by reading current rule, never replayed", async ({ page }) => {
  const state = await setup(page);
  let writes = 0;
  await page.route("**/api/rules/71", async r => {
    writes++;
    state.rule = { ...state.rule, amount: { amount: 444000, currency: "KRW" }, edit_token: '"saved"' };
    await r.abort("failed");
  });
  await form(page).getByLabel("금액/회 (원)").fill("444000");
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("저장 결과를 확인하지 못했습니다");
  await expect(save(page)).toBeDisabled();
  await page.getByRole("button", { name: "작성 내용을 유지하고 최신 내용 확인" }).click();
  await expect(form(page)).toHaveCount(0);
  expect(writes).toBe(1);
});

test("pending save prevents duplicates and navigation; dirty draft can stay", async ({ page }) => {
  await setup(page);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let writes = 0;
  await page.route("**/api/rules/71", async r => { writes++; await gate; await r.fulfill({ status: 503, json: { detail: { code: "database_busy", message: "busy" } } }); });
  await form(page).getByLabel("금액/회 (원)").fill("500000");
  await save(page).click();
  await expect(page.getByRole("button", { name: "저장 중…" })).toBeDisabled();
  await page.getByRole("button", { name: "대시보드", exact: true }).click();
  await expect(page.getByRole("button", { name: "화면 떠나기" })).toBeDisabled();
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  finish();
  await expect(save(page)).toBeEnabled();
  expect(writes).toBe(1);
});

for (const response of [null, { id: 999 }, "server-error"]) test(`uncertain response ${JSON.stringify(response)} requires read before retry`, async ({ page }) => {
  await setup(page);
  await page.route("**/api/rules/71", r => r.fulfill({ status: response === "server-error" ? 500 : 200, contentType: "application/json", body: JSON.stringify(response) }));
  await form(page).getByLabel("금액/회 (원)").fill("999000");
  await save(page).click();
  await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("저장 결과를 확인하지 못했습니다");
  await page.route("**/api/rules?*", r => r.abort("failed"));
  await page.getByRole("button", { name: "작성 내용을 유지하고 최신 내용 확인" }).click();
  await expect(page.getByRole("alert")).toContainText("최신 내용을 불러오지 못했습니다");
  await expect(form(page).getByLabel("금액/회 (원)")).toHaveValue("999000");
  await expect(save(page)).toBeDisabled();
});

test("deleted rule retains draft and disables saving", async ({ page }) => {
  await setup(page);
  await page.route("**/api/rules/71", r => r.fulfill({ status: 404, json: { detail: { code: "rule_not_found", message: "없음" } } }));
  await form(page).getByLabel("내역", { exact: true }).fill("작성 내용");
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("삭제되었습니다");
  await expect(form(page).getByLabel("내역", { exact: true })).toHaveValue("작성 내용");
  await expect(save(page)).toBeDisabled();
});

test("real API round trip preserves rule identity and existing transactions", async ({ page, request }) => {
  const base = (process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`).replace(/\/+$/, "");
  const incomeResponse = await request.post(`${base}/accounts`, { data: { name: "규칙편집 급여", type: "income" } });
  const cashResponse = await request.post(`${base}/accounts`, { data: { name: "규칙편집 통장", type: "asset" } });
  const income = await incomeResponse.json(), cash = await cashResponse.json();
  const createdResponse = await request.post(`${base}/rules`, { data: { description: "규칙편집 실서버", from_account_id: income.id, to_account_id: cash.id,
    amount: 123456, schedule: "monthly:31", start_date: "2024-01-01", end_date: "2024-02-29" } });
  expect(createdResponse.status()).toBe(201);
  const original = await createdResponse.json();
  await request.post(`${base}/materialize`);
  const before = (await (await request.get(`${base}/transactions`)).json()).filter((t: { source_rule_id: number }) => t.source_rule_id === original.id);
  try {
    await page.goto("/rules");
    await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
    await page.getByRole("row").filter({ hasText: "규칙편집 실서버" }).getByRole("button", { name: "수정", exact: true }).click();
    await form(page).getByLabel("금액/회 (원)").fill("234567");
    await save(page).click();
    await expect(form(page)).toHaveCount(0);
    const current = (await (await request.get(`${base}/rules`)).json()).find((r: Rule) => r.id === original.id);
    expect(current).toMatchObject({ id: original.id, amount: { amount: 234567 }, schedule: original.schedule,
      start_date: original.start_date, end_date: original.end_date, last_materialized: "2024-02-29" });
    const after = (await (await request.get(`${base}/transactions`)).json()).filter((t: { source_rule_id: number }) => t.source_rule_id === original.id);
    expect(after).toEqual(before);
  } finally {
    await request.delete(`${base}/rules/${original.id}`);
    for (const t of before) await request.delete(`${base}/transactions/${t.id}`);
  }
});

test("same accounts are rejected before a write", async ({ page }) => {
  const state = await setup(page);
  await form(page).getByLabel("어디로 (to)").selectOption("102");
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText("서로 다른 계정");
  expect(state.writes).toBe(0);
});
