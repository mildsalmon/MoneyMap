import { expect, test, type Page, type Route } from "./test";
import AxeBuilder from "@axe-core/playwright";
import { statisticsPeriodError, statisticsPreset, readStatisticsPeriod } from "../src/views/statisticsQuery";
import { groupStatistics } from "../src/views/statisticsGroups";
import { fmtWon } from "../src/format";
import type { Statistics } from "../src/api/statistics";
import type { Account } from "../src/api";

const range = "start=2026-01-01&end=2026-02-28";
const endpoint = "**/api/statistics?*";
const base = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
const account = (id: number, name: string, type: Account["type"], extra: Partial<Account> = {}): Account => ({ id, name, type, parent_id: null,
  currency: "KRW", archived: false, is_placeholder: false, is_system: false, is_overdraft: false, position: id, version: 1, ...extra });
function body(start = "2026-01-01", end = "2026-02-28"): Statistics {
  return { start, end, as_of: "2026-10-25", currency: "KRW", transaction_count: 3, excluded_transaction_count: 2,
    summary: { income: 1000, expense: 80, net_income: 920, opening_net_worth: -1420,
      net_worth: -500, net_worth_change: 920, assets: 0, liabilities: 500, capital_change: 0, reconciliation_difference: 0 },
    monthly: [{ month: start.slice(0, 7), through: end, income: 1000, expense: 80, net_income: 920, capital_change: 0, net_worth: -500 }],
    accounts: [account(1, "통장 그룹", "asset", { is_placeholder: true }), account(2, "마이너스", "asset", { parent_id: 1, is_overdraft: true, archived: true }),
      account(10, "비용 그룹", "expense", { is_placeholder: true }), account(11, "환불 분류", "expense", { parent_id: 10, archived: true }), account(20, "급여", "income")],
    balances: [
      { account_id: 1, opening: 0, balance: 0, period: 0, activity: 0, reporting_type: "asset" },
      { account_id: 2, opening: -1420, balance: -500, period: 920, activity: 3, reporting_type: "liability" },
      { account_id: 10, opening: 0, balance: 100, period: 100, activity: 1, reporting_type: "expense" },
      { account_id: 11, opening: 0, balance: -20, period: -20, activity: 2, reporting_type: "expense" },
      { account_id: 20, opening: 0, balance: -1000, period: -1000, activity: 1, reporting_type: "income" }],
  };
}
async function setup(page: Page) {
  await page.clock.install({ time: new Date("2026-10-25T01:00:00Z") });
  await page.route("**/api/materialize", r => r.fulfill({ json: { created: 0, transactions: [] } }));
  const requests: string[] = [];
  await page.route(endpoint, r => {
    requests.push(r.request().url()); const p = new URL(r.request().url()).searchParams;
    return r.fulfill({ json: body(p.get("start")!, p.get("end")!) });
  });
  return requests;
}
async function ready(page: Page) {
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await expect(page.locator(".statistics-result-title")).toContainText("3건");
}

test("period presets, invalid/duplicate URL and large exact group totals", () => {
  expect(statisticsPreset("this-month", "2026-10-25")).toEqual({ start: "2026-10-01", end: "2026-10-25" });
  expect(statisticsPreset("last-month", "2024-03-10")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  expect(statisticsPreset("recent-year", "2026-01-02").start).toBe("2025-02-01");
  expect(statisticsPreset("recent-year", "2026-12-02").start).toBe("2026-01-01");
  expect(statisticsPeriodError({ start: "2026-02-30", end: "2026-03-01" })).toBeTruthy();
  expect(statisticsPeriodError({ start: "2026-03-02", end: "2026-03-01" })).toBeTruthy();
  expect(statisticsPeriodError({ start: "2000-01-01", end: "2026-03-01" })).toContain("3660");
  expect(statisticsPeriodError({ start: "2026-03-01", end: "2026-03-02" }, "2026-03-01")).toContain("서울");
  expect(readStatisticsPeriod("?start=2026-01-01&start=2026-01-02&end=2026-02-01").error).toBeTruthy();
  expect(fmtWon(-9_007_199_254_740_993n)).toBe("−₩9,007,199,254,740,993");
  expect(fmtWon(9_007_199_254_740_993n)).toBe("₩9,007,199,254,740,993");
  expect(groupStatistics(body(), "expense")[0].total).toBe(80n);
  expect(groupStatistics(body(), "expense")[0].items.map(r => r.label)).toEqual(["직접 기록", "환불 분류"]);
  expect(groupStatistics(body(), "asset")).toEqual([]);
  expect(groupStatistics(body(), "liability")[0].total).toBe(500n);
  const zero = body(); zero.balances.find(row => row.account_id === 11)!.period = -100;
  expect(groupStatistics(zero, "expense")[0].total).toBe(0n);
  expect(groupStatistics(zero, "expense")[0].items).toHaveLength(2);
  const large = body();
  for (const row of large.balances.filter(row => [10, 11].includes(row.account_id))) row.period = Number.MAX_SAFE_INTEGER;
  expect(groupStatistics(large, "expense")[0].total).toBe(18_014_398_509_481_982n);
});

test("drafts wait for apply; presets, URL/back, grouping and amounts remain explicit", async ({ page }) => {
  const requests = await setup(page); await page.goto(`/statistics?${range}`); await ready(page);
  const count = requests.length;
  await page.getByLabel("종료일", { exact: true }).fill("2026-02-27");
  expect(requests).toHaveLength(count);
  await expect(page.getByText("조회 버튼을 눌러 적용하세요. 아래는 이전 조건의 결과입니다.")).toBeVisible();
  await page.getByLabel("종료일", { exact: true }).press("Enter");
  await expect(page).toHaveURL(/end=2026-02-27/);
  await expect(page.locator(".statistics-result-title")).toBeFocused();
  await expect(page.locator(".statistics-result-title")).toContainText("2026-02-27");
  await page.getByRole("button", { name: "이번 달", exact: true }).click();
  await expect(page).toHaveURL(/start=2026-10-01&end=2026-10-25/);
  await page.goBack(); await expect(page.getByLabel("종료일", { exact: true })).toHaveValue("2026-02-27");
  const expense = page.getByRole("table", { name: "기간 지출 구성", exact: true });
  await expect(expense).toContainText("직접 기록"); await expect(expense).toContainText("−₩20");
  await expect(expense.getByRole("row").filter({ hasText: "비용 그룹 소계" })).toContainText("₩80");
  await expect(page.getByRole("table", { name: "기간말 부채 구성", exact: true })).toContainText("마이너스");
  await expect(page.getByRole("table", { name: "기간말 자산 구성", exact: true })).not.toContainText("마이너스");
  await expect(page.getByText(/거래 2건 전체를 제외/)).toBeVisible();
});

test("pending results hide old amounts, failures retry applied criteria and late responses cannot win", async ({ page }) => {
  await setup(page); await page.goto(`/statistics?${range}`); await ready(page);
  const held: Route[] = []; await page.route(endpoint, r => { held.push(r); });
  await page.getByLabel("종료일", { exact: true }).fill("2026-02-27"); await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect.poll(() => held.length).toBe(1);
  await expect(page.locator(".statistics-summary")).toHaveCount(0);
  await held[0].fulfill({ status: 503, json: { detail: "집계 실패" } });
  await expect(page.getByRole("alert")).toContainText("집계 실패");
  await page.getByLabel("종료일", { exact: true }).fill("2026-02-26");
  await page.getByRole("button", { name: "다시 조회", exact: true }).click();
  await expect.poll(() => held.length).toBe(2);
  expect(new URL(held[1].request().url()).searchParams.get("end")).toBe("2026-02-27");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect.poll(() => held.length).toBe(3);
  await held[2].fulfill({ json: body("2026-01-01", "2026-02-26") });
  await expect(page.locator(".statistics-result-title")).toContainText("2026-02-26");
  await held[1].fulfill({ json: body("2026-01-01", "2026-02-27") }).catch(() => {});
  await expect(page.locator(".statistics-result-title")).not.toContainText("2026-02-27");
});

for (const timezoneId of ["Asia/Seoul", "America/Los_Angeles"]) test.describe(timezoneId, () => {
  test.use({ timezoneId });
  test("default dates use the same Seoul day even across UTC/local midnight", async ({ page }) => {
    await setup(page); await page.clock.setSystemTime(new Date("2026-10-25T15:30:00Z"));
    await page.goto("/statistics"); await ready(page);
    await expect(page).toHaveURL(/start=2026-01-01&end=2026-10-26/);
  });
});

test("invalid URL never queries, corrected form recovers, mobile exact tables and axe", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = await setup(page); await page.goto("/statistics?start=bad&end=2026-02-28");
  await expect(page.getByRole("alert")).toContainText("올바른 시작일"); expect(requests).toHaveLength(0);
  await page.getByLabel("시작일", { exact: true }).fill("2026-01-01");
  await page.getByRole("button", { name: "조회", exact: true }).click(); await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.getByRole("button", { name: "조회", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.locator(".main").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath("statistics-mobile-top.png"), fullPage: true });
  await page.getByRole("region", { name: "월별 통계 표", exact: true }).focus();
  await expect(page.getByRole("table", { name: "월별 수입·지출과 순자산", exact: true })).toContainText("−₩500");
  expect((await new AxeBuilder({ page }).include(".statistics-page").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("statistics-mobile.png"), fullPage: true });
});

test("real ledger API and page agree for transfers, purchase/refund and equity without rewriting ledger", async ({ page, request }, info) => {
  const ids: number[] = [], accounts: number[] = [];
  for (const type of ["asset", "income", "expense", "equity"]) {
    const r = await request.post(`${base}/accounts`, { data: { type, name: `통계-${type}-${crypto.randomUUID()}` } });
    expect(r.ok()).toBeTruthy(); accounts.push((await r.json()).id);
  }
  const post = async (date: string, debit: number, credit: number, amount: number) => {
    const r = await request.post(`${base}/transactions`, { data: { date, postings: [{ account_id: debit, amount }, { account_id: credit, amount: -amount }] } });
    expect(r.ok()).toBeTruthy(); ids.push((await r.json()).id);
  };
  try {
    await post("2000-01-01", accounts[0], accounts[3], 3000);
    await post("2000-01-15", accounts[0], accounts[1], 500);
    await post("2000-01-16", accounts[2], accounts[0], 100);
    await post("2000-01-17", accounts[0], accounts[2], 20);
    const response = await request.get(`${base}/statistics?start=2000-01-01&end=2000-02-01`);
    expect(response.ok()).toBeTruthy(); const data: Statistics = await response.json();
    expect(data.summary).toMatchObject({ income: 500, expense: 80, net_income: 420, capital_change: 3000, net_worth: 3420, reconciliation_difference: 0 });
    await page.goto("/statistics?start=2000-01-01&end=2000-02-01");
    await expect(page.locator(".statistics-result-title")).toContainText("4건");
    const stocks = page.getByLabel("기간말 자산과 변화", { exact: true });
    await expect(stocks).toContainText("₩3,420"); await expect(stocks).toContainText("₩3,000");
    for (const id of ids) expect((await request.get(`${base}/transactions/${id}`)).ok()).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: info.outputPath("statistics-desktop.png"), fullPage: true });
  } finally { for (const id of ids) await request.delete(`${base}/transactions/${id}`); }
});


test("negative monthly income and refunds keep bars within bounds and exact signed table values", async ({ page }) => {
  await setup(page);
  await page.route(endpoint, r => {
    const data = body();
    data.monthly[0] = { ...data.monthly[0], income: -100, expense: -80, net_income: -20 };
    return r.fulfill({ json: data });
  });
  await page.goto(`/statistics?${range}`); await ready(page);
  const table = page.getByRole("table", { name: "월별 수입·지출과 순자산", exact: true });
  await expect(table).toContainText("−₩100"); await expect(table).toContainText("−₩80");
  await expect(table).toContainText("−₩20");
  const bars = await page.locator(".statistics-monthly rect").evaluateAll(nodes => nodes.map(n => ({
    y: Number(n.getAttribute("y")), h: Number(n.getAttribute("height")),
  })));
  expect(bars).toHaveLength(2);
  for (const bar of bars) { expect(bar.y).toBeGreaterThanOrEqual(16); expect(bar.h).toBeGreaterThanOrEqual(0); expect(bar.y + bar.h).toBeLessThanOrEqual(178.001); }
});


test("historical Seoul calendar dates survive a skipped browser-local date", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Apia";
    expect(statisticsPeriodError({ start: "2011-12-30", end: "2011-12-30" }, "2012-01-01")).toBeUndefined();
    expect(statisticsPreset("last-month", "2012-01-01")).toEqual({ start: "2011-12-01", end: "2011-12-31" });
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test("mobile long group names leave exact amounts visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.route(endpoint, route => {
    const data = body(); data.accounts.find(a => a.id === 10)!.name = "longaccountname".repeat(10);
    return route.fulfill({ json: data });
  });
  await page.goto(`/statistics?${range}`); await ready(page);
  const table = page.getByRole("table", { name: "기간 지출 구성", exact: true });
  await table.scrollIntoViewIfNeeded();
  for (const cell of await table.locator("td.num").all()) {
    const box = (await cell.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
});
