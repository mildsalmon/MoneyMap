import { expect, test, type Page, type Route } from "./test";

const expenses = Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i, name: i === 0 ? "아주 긴 이름의 생활용품과 가전제품 구매 비용 분류" : `비용 ${i + 1}`,
  type: "expense", archived: i === 8,
}));
const accounts = [
  { id: 1, name: "통장", type: "asset", archived: false },
  { id: 2, name: "수입", type: "income", archived: false },
  { id: 3, name: "카드", type: "liability", archived: false },
  ...expenses,
  { id: 999, name: "거래 없는 비용", type: "expense", archived: false },
];
let nextId = 1;
const txn = (date: string, entries: [number, number][]) => ({
  id: nextId++, date, description: "합성 거래", scenario_id: 1,
  postings: entries.map(([account_id, amount]) => ({ account_id, amount: { amount, currency: "KRW" } })),
});
const transactions = [
  // Deliberately unsorted; preserve insertion order 101 → 102 for equal totals.
  ...[4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3].map(i =>
    txn("2026-09-05", [[expenses[i].id, (12 - i) * 1000], [1, -(12 - i) * 1000]])),
  txn("2026-09-06", [[100, 500], [101, 500], [1, -1000]]), // split expense
  txn("2026-09-07", [[100, -500], [1, 500]]),
  txn("2026-09-08", [[101, -1500], [1, 1500]]), // same total as 102
  txn("2026-09-09", [[110, -2000], [1, 2000]]), // zero
  txn("2026-09-10", [[111, -3000], [1, 3000]]), // negative
  txn("2026-08-31", [[999, 900000], [1, -900000]]),
  txn("2026-10-01", [[999, 900000], [1, -900000]]),
  txn("2026-09-15", [[1, 50000], [2, -50000]]),
  txn("2026-09-15", [[3, 7000], [1, -7000]]),
];
const expectedAmounts = [12000, 10000, 10000, 9000, 8000, 7000, 6000, 5000, 4000, 3000, 0, -2000];
// Match the table, not the identically named summary metric. Also works before the title change.
const ledger = (page: Page) => page.getByRole("table").filter({ hasText: "이번 달 지출" });

async function setup(page: Page, txns = transactions) {
  await page.clock.setFixedTime(new Date("2026-09-15T12:00:00+09:00"));
  await page.addInitScript(() => localStorage.setItem("moneymap.opening_skipped", "1"));
  await page.route("**/api/materialize", r => r.fulfill({ json: { created: 0, transactions: [] } }));
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: txns }));
  await page.route("**/api/rules?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/balances?*", r => r.fulfill({ json: {
    net_worth: 1500, accounts: [{ account_id: 1, name: "통장", type: "asset", reporting_type: "asset", balance: 1500 }],
  } }));
  await page.route("**/api/dashboard-projection?*", r => r.fulfill({ json: { series: [] } }));
}

test("all monthly expense accounts retain exact totals, ties, refunds and archived rows", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  const rows = ledger(page).locator("tbody tr");
  await expect(rows).toHaveCount(12);
  await expect(ledger(page).getByRole("columnheader", { name: "이번 달 지출", exact: true })).toBeVisible();
  for (let i = 0; i < expenses.length; i++) {
    await expect(rows.nth(i).locator("td")).toHaveText([expenses[i].name, expectedAmounts[i].toLocaleString("ko-KR")]);
  }
  await expect(ledger(page)).not.toContainText("거래 없는 비용");
  await expect(page.locator(".strip .cell").filter({ hasText: "이번 달 지출" })).toContainText("₩72,000");
  await expect(page.locator(".strip .cell").filter({ hasText: "이번 달 수입" })).toContainText("₩50,000");
  await expect(page.getByRole("heading", { name: "대시보드, 오늘 순자산 ₩1,500" })).toBeVisible();
  await expect(page.getByRole("button", { name: /더보기|전체 보기|접기/ })).toHaveCount(0);
});

test("a month without expenses shows the empty state and reload replaces it with current data", async ({ page }) => {
  await setup(page, transactions.filter(t => !t.date.startsWith("2026-09")));
  await page.goto("/");
  await expect(ledger(page)).toContainText("이번 달 지출 기록이 없습니다");
  await page.route("**/api/transactions?*", r => r.fulfill({ json: transactions }));
  await page.reload();
  await expect(ledger(page).locator("tbody tr")).toHaveCount(12);
  await expect(ledger(page)).not.toContainText("이번 달 지출 기록이 없습니다");
});

test("pending and failed transaction loads are not empty months and retry restores every row", async ({ page }) => {
  await setup(page);
  const held: Route[] = [];
  await page.route("**/api/transactions?*", r => { held.push(r); });
  await page.goto("/");
  await expect(page.getByText("장부 정보 확인 중…", { exact: true })).toBeVisible();
  await expect(ledger(page).locator("tbody tr")).toHaveCount(0);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await page.route("**/api/transactions?*", r => r.fulfill({ status: 503, json: { detail: "거래 조회 실패" } }));
  for (const route of held) await route.fulfill({ status: 503, json: { detail: "거래 조회 실패" } }).catch(() => {});
  const alert = page.getByRole("alert").filter({ hasText: "장부 정보를 불러오지 못했습니다." });
  await expect(alert).toBeVisible();
  await expect(ledger(page)).not.toContainText("이번 달 지출 기록이 없습니다");
  await page.route("**/api/transactions?*", r => r.fulfill({ json: transactions }));
  await alert.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(ledger(page).locator("tbody tr")).toHaveCount(12);
  await expect(alert).toBeHidden();
});

for (const width of [1440, 390]) {
  test(`all expense rows and long names remain readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(page, transactions.map(t => ({ ...t, postings: t.postings.map(p => ({
      ...p, amount: { ...p.amount, amount: p.amount.amount * 100000 },
    })) })));
    await page.goto("/");
    const rows = ledger(page).locator("tbody tr");
    await expect(rows).toHaveCount(12);
    await expect(rows.first().locator("td").last()).toHaveText("1,200,000,000");
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows.last()).toBeInViewport();
    const boxes = await rows.first().locator("td").evaluateAll(cells => cells.map(c => {
      const r = c.getBoundingClientRect();
      return { left: r.left, right: r.right, scrollWidth: c.scrollWidth, clientWidth: c.clientWidth };
    }));
    expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].left + 1);
    expect(boxes[1].right).toBeLessThanOrEqual(width);
    expect(boxes[0].scrollWidth).toBeLessThanOrEqual(boxes[0].clientWidth + 1);
    const tables = await page.locator(".two > *").evaluateAll(tables => tables.map(t => {
      const r = t.getBoundingClientRect(); return { top: r.top, bottom: r.bottom };
    }));
    if (width > 720) expect(Math.abs(tables[0].top - tables[1].top)).toBeLessThan(1);
    else expect(tables[1].top).toBeGreaterThan(tables[0].bottom);
  });
}
