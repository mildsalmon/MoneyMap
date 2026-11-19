import { accountListUrl, test, expect, type Page } from "./test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const accounts = [
  { id: 901, name: "생활 통장", type: "asset" },
  { id: 902, name: "생활 카드", type: "liability" },
  { id: 903, name: "급여", type: "income" },
  { id: 904, name: "식비", type: "expense" },
  { id: 905, name: "교통비", type: "expense" },
].map((a, position) => ({ parent_id: null, archived: false, is_placeholder: false,
  is_system: false, is_overdraft: false, include_in_cash: false, currency: "KRW", version: 1, position: position + 1, ...a }));
const transactions = [
  { id: 1, date: "2026-11-01", description: "11월 급여", entries: [[901, 4200000], [903, -4200000]] },
  { id: 2, date: "2026-11-10", description: "장보기", entries: [[904, 185000], [901, -185000]] },
  { id: 3, date: "2026-11-12", description: "교통 정기권", entries: [[905, 65000], [901, -65000]] },
].map(({ entries, ...t }) => ({ ...t, scenario_id: 1, memo: "", tags: [], source_rule_id: null,
  postings: entries.map(([account_id, amount]) => ({ account_id, amount: { amount, currency: "KRW" } })) }));
async function setup(page: Page) {
  await page.clock.setFixedTime(new Date("2026-11-15T12:00:00+09:00"));
  await page.route("**/api/materialize", r => r.fulfill({ json: { created: 0, transactions: [] } }));
  await page.route("**/api/status", r => r.fulfill({ json: { trial_balance_ok: true, last_entry: "2026-11-12", last_backup: "2026-11-15" } }));
  await page.route(accountListUrl, r => r.fulfill({ json: accounts }));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: transactions }));
  await page.route("**/api/rules?*", r => r.fulfill({ json: [1, 2].map(id => ({ id, scenario_id: 1,
    description: `월급 규칙 ${id}`, from_account_id: 903, to_account_id: 901,
    amount: { amount: 4200000, currency: "KRW" }, schedule: { spec: "monthly:25" },
    start_date: "2026-11-01", end_date: null, last_materialized: null })) }));
  await page.route("**/api/balances?*", r => r.fulfill({ json: { net_worth: 42580000, accounts: [
    { account_id: 901, name: "생활 통장", type: "asset", reporting_type: "asset", balance: 43200000 },
    { account_id: 902, name: "생활 카드", type: "liability", reporting_type: "liability", balance: -620000 },
  ] } }));
  await page.route("**/api/dashboard-projection?*", r => r.fulfill({ json: { series: [
    { id: "actual", name: "실제", kind: "actual", points: [{ date: "2026-08-15", net_worth: 31000000 }, { date: "2026-10-15", net_worth: 38600000 }, { date: "2026-11-15", net_worth: 42580000 }] },
    { id: "baseline", name: "현재 패턴 유지", kind: "baseline", points: [{ date: "2026-11-15", net_worth: 42580000 }, { date: "2027-02-15", net_worth: 49200000 }, { date: "2027-05-15", net_worth: 56400000 }, { date: "2027-11-15", net_worth: 69800000 }] },
  ] } }));
}

for (const width of [1440, 1024, 720, 390]) {
  test(`violet workspace preserves financial content, navigation and accessibility at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page); await page.goto("/");
    await expect(page.locator(".strip .hero")).toHaveText("₩42,580,000");
    await expect(page.locator(".strip .cell")).toHaveCount(4);
    await expect(page.locator(".strip .cell").filter({ hasText: "이번 달 수입" })).toContainText("₩4,200,000");
    await expect(page.locator(".strip .cell").filter({ hasText: "이번 달 지출" })).toContainText("₩250,000");
    await expect(page.locator(".strip .cell").last()).toContainText("₩3,950,000");
    await expect(page.locator(".side nav button")).toHaveCount(8);
    await expect(page.locator(".side nav button[aria-current=page]")).toHaveText("대시보드");
    await expect(page.getByRole("table", { name: "자산 잔액", exact: true })).toContainText("43,200,000");
    await expect(page.getByRole("table", { name: "부채 잔액", exact: true })).toContainText("-620,000");
    await expect(page.locator(".chart-wrap svg")).toBeVisible();
    if (width <= 720) {
      const chartWidth = await page.locator(".chart-wrap svg").evaluate(svg => svg.getBoundingClientRect().width);
      expect(chartWidth).toBeGreaterThanOrEqual(920);
      await expect(page.locator(".dashboard-chart-scroll-hint")).toBeVisible();
      await expect(page.getByRole("button", { name: "표로 보기", exact: true })).toBeInViewport();
      const region = page.getByRole("region", { name: "자산 흐름 차트와 표", exact: true });
      expect(await region.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const navHeights = await page.locator(".side nav button").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
    expect(Math.min(...navHeights)).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    if (width === 1440 || width === 390) {
      const directory = join(homedir(), ".gstack/projects/MoneyMap/designs/violet-workspace-20261115");
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: join(directory, `dashboard-${width}.png`), fullPage: true });
    }
    if (width === 1440) {
      await page.getByRole("button", { name: "반복 규칙 관리", exact: true }).click();
      await expect(page).toHaveURL(/\/rules$/);
      await expect(page.getByRole("cell", { name: "월급 규칙 1", exact: true })).toBeVisible();
      await page.locator(".side nav").getByRole("button", { name: "대시보드", exact: true }).click();
      await page.getByRole("button", { name: /^새 거래 기록/ }).click();
      await expect(page).toHaveURL(/\/transactions\/new$/);
      await page.locator(".side nav").getByRole("button", { name: "대시보드", exact: true }).click();
      await page.getByRole("button", { name: /^거래 모두 보기/ }).click();
    } else {
      await page.locator(".side nav").getByRole("button", { name: "거래 내역", exact: true }).click();
    }
    await expect(page).toHaveURL(/\/transactions/);
    await expect(page.locator(".side nav button[aria-current=page]")).toHaveText("거래 내역");
  });
}
