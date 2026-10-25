import { test, expect, type Page } from "./test";
import type { Series } from "../src/api";

const point = (date: string, net_worth: number) => ({ date, net_worth });
const original: Series[] = [
  { id: "actual", name: "실제", kind: "actual", points: [point("2026-10-24", -1000), point("2026-10-25", -1000)] },
  { id: "baseline", name: "현재 패턴 유지", kind: "baseline", points: [point("2026-10-25", -1000), point("2026-10-26", 2000), point("2026-10-28", 2000)] },
  { id: 2, name: "짧은 가정", kind: "scenario", points: [point("2026-10-25", -1000), point("2026-10-26", 500)] },
];
async function start(page: Page, series: Series[]) {
  await page.clock.install({ time: new Date("2026-10-25T12:00:00Z") });
  await page.addInitScript(() => localStorage.setItem("moneymap.opening_skipped", "1"));
  await page.route("**/api/materialize", r => r.fulfill({ json: { created: 0, transactions: [] } }));
  await page.route("**/api/accounts", r => r.fulfill({ json: [{ id: 1, name: "통장", type: "asset", archived: false }] }));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/rules?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/balances?*", r => r.fulfill({ json: { net_worth: -1000, accounts: [] } }));
  await page.route("**/api/dashboard-projection?*", r => r.fulfill({ json: { series } }));
  await page.goto("/");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await expect(page.locator(".chart-wrap svg")).toBeVisible();
}

for (const timezoneId of ["Asia/Seoul", "America/Los_Angeles"]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });
    test("table and keyboard tooltip respect exact API dates, negative values and each series end", async ({ page }) => {
      await start(page, original);
      await page.getByRole("button", { name: "표로 보기", exact: true }).click();
      const rows = page.locator("table.ledger").filter({ has: page.getByRole("columnheader", { name: "날짜", exact: true }) }).locator("tbody tr");
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0).locator("td")).toHaveText(["2026-10-24", "−₩1,000", "—", "—"]);
      await expect(rows.nth(1).locator("td")).toHaveText(["2026-10-25", "−₩1,000", "−₩1,000", "−₩1,000"]);
      await expect(rows.nth(2).locator("td")).toHaveText(["2026-10-26", "—", "₩2,000", "₩500"]);
      await expect(rows.nth(3).locator("td")).toHaveText(["2026-10-28", "—", "₩2,000", "—"]);
      const chart = page.locator(".chart-wrap"); await chart.focus();
      for (let i = 0; i < 4; i++) await chart.press("ArrowRight");
      await expect(page.locator(".chart-tip .date")).toHaveText("2026-10-28");
      await expect(page.locator(".chart-tip .row .name")).toHaveText(["현재 패턴 유지"]);
      await expect(page.locator(".chart-tip .val")).toHaveText("₩2,000");
      await chart.press("ArrowLeft");
      await expect(page.locator(".chart-tip .row .name")).toHaveText(["현재 패턴 유지", "짧은 가정"]);
      await expect(page.locator(".chart-tip .sub")).toHaveText(" (−₩1,500 기준 대비)");
      await chart.press("Escape"); await expect(page.locator(".chart-tip")).toHaveCount(0);
    });
  });
}

for (const width of [390, 1440]) test(`clustered negative endpoints stay inside the chart without overlap at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const series = [original[0], original[1], ...[2, 3, 4].map(id => ({ ...original[2], id, name: `가정 ${id}` }))]
    .map(s => ({ ...s, points: [point("2026-10-24", 10000), point(s.kind === "actual" ? "2026-10-25" : "2026-10-28", -1000)] }));
  await start(page, series);
  const labels = await page.locator(".chart-wrap svg > g").filter({ has: page.locator("circle") }).locator("text").evaluateAll(nodes => nodes.map(n => ({ y: Number(n.getAttribute("y")), h: (n as SVGGraphicsElement).getBBox().height })).sort((a, b) => a.y - b.y));
  expect(labels).toHaveLength(5);
  for (const label of labels) { expect(label.y - label.h).toBeGreaterThanOrEqual(0); expect(label.y).toBeLessThanOrEqual(254); }
  for (let i = 1; i < labels.length; i++) expect(labels[i].y - labels[i - 1].y).toBeGreaterThanOrEqual(15);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`projection-endpoints-${width}.png`), fullPage: true });
});
