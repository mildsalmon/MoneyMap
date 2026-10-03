import { expect, test, type Page, type Route } from "./test";

const accounts = [
  { id: 1, name: "사용 통장", type: "asset", archived: false },
  { id: 2, name: "보관 예금", type: "asset", archived: true },
  { id: 3, name: "보관 카드", type: "liability", archived: true },
  { id: 4, name: "보관 영원", type: "asset", archived: true },
  { id: 5, name: "사용 영원", type: "asset", archived: false },
  { id: 6, name: "사용 마이너스", type: "asset", archived: false },
];
const balances = {
  net_worth: 1150,
  accounts: accounts.map((a, i) => ({ account_id: a.id, name: a.name, type: a.type,
    reporting_type: a.id === 6 ? "liability" : a.type, balance: [1000, 500, -200, 0, 0, -150][i] })),
};
const ledger = (page: Page) => page.getByRole("region", { name: "계정 잔액" });

test("only known active asset and liability rows appear, including empty balance results", async ({ page }) => {
  await setup(page);
  await page.route("**/api/accounts", r => r.fulfill({ json: [
    ...accounts,
    { id: 7, name: "수익 계정", type: "income", archived: false },
  ] }));
  await page.route("**/api/balances?*", r => r.fulfill({ json: {
    net_worth: 1150,
    accounts: [
      ...balances.accounts,
      { account_id: 7, name: "수익 계정", type: "income", reporting_type: "income", balance: 800 },
      { account_id: 99, name: "상태 미확인 계정", type: "asset", reporting_type: "asset", balance: 900 },
    ],
  } }));
  await page.goto("/");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  await expect(ledger(page).getByText("사용 통장", { exact: true })).toBeVisible();
  await expect(ledger(page).locator(".dashboard-account-cell")).toHaveCount(3);
  for (const name of ["수익 계정", "상태 미확인 계정"]) {
    await expect(ledger(page).getByText(name, { exact: true })).toHaveCount(0);
  }
  await expect(ledger(page).locator(".sum")).toHaveText("전체 순자산 (보관 계정 포함)₩1,150");

  await page.route("**/api/balances?*", r => r.fulfill({ json: { net_worth: 0, accounts: [] } }));
  await page.reload();
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  await expect(page.getByText("장부 정보 확인 중…", { exact: true })).toBeHidden();
  await expect(ledger(page).locator(".sum")).toHaveText("전체 순자산 (보관 계정 포함)₩0");
  await expect(ledger(page).locator(".dashboard-account-cell")).toHaveCount(0);
});

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem("moneymap.opening_skipped", "1"));
  await page.route("**/api/materialize", r => r.fulfill({ json: { created: 0, transactions: [] } }));
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/rules?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/balances?*", r => r.fulfill({ json: balances }));
  await page.route("**/api/dashboard-projection?*", r => r.fulfill({ json: { series: [] } }));
}

test("archived balances stay in net worth but not the list, and restoration shows them again", async ({ page }) => {
  await setup(page);
  await page.goto("/");
  await expect(ledger(page).getByText("사용 통장", { exact: true })).toBeVisible();
  for (const name of ["보관 예금", "보관 카드", "보관 영원"]) {
    await expect(ledger(page).getByRole("row").filter({ hasText: name })).toHaveCount(0);
  }
  await expect(ledger(page).getByText("사용 영원", { exact: true })).toBeVisible();
  await expect(ledger(page).getByRole("row").filter({ hasText: "사용 마이너스" })).toContainText("부채 · 마이너스 사용 중");
  await expect(page.getByRole("heading", { name: "대시보드, 오늘 순자산 ₩1,150" })).toBeVisible();
  await expect(ledger(page).locator(".sum")).toContainText("₩1,150");
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts.map(a => ({ ...a, archived: false })) }));
  await page.reload();
  for (const name of ["보관 예금", "보관 카드", "보관 영원"]) {
    await expect(ledger(page).getByRole("row").filter({ hasText: name })).toBeVisible();
  }
  await expect(ledger(page).locator(".sum")).toContainText("₩1,150");
});

test("unconfirmed account status never exposes balances during loading or failure; retry recovers", async ({ page }) => {
  await setup(page);
  const pending: Route[] = [];
  await page.route("**/api/accounts", r => { pending.push(r); });
  await page.goto("/");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  await expect(ledger(page).locator(".sum")).toContainText("₩1,150");
  await expect(page.getByText("장부 정보 확인 중…", { exact: true })).toBeVisible();
  await expect(ledger(page).locator(".dashboard-account-cell")).toHaveCount(0);
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  for (const route of pending) {
    await route.fulfill({ status: 503, json: { detail: "계정 상태 조회 실패" } }).catch(() => {});
  }
  const alert = page.getByRole("alert").filter({ hasText: "장부 정보를 불러오지 못했습니다." });
  await expect(alert).toBeVisible();
  await expect(ledger(page).locator(".dashboard-account-cell")).toHaveCount(0);
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await alert.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(ledger(page).getByText("사용 통장", { exact: true })).toBeVisible();
  await expect(ledger(page).getByText("보관 예금", { exact: true })).toHaveCount(0);
  await expect(ledger(page).locator(".sum")).toContainText("₩1,150");
});

test("groups preserve order, sum own balances once and split overdrafts", async ({ page }) => {
  await setup(page);
  const grouped = [
    { id: 10, name: "생활 자금", type: "asset", parent_id: null, position: 2, is_placeholder: false },
    { id: 11, name: "통장", type: "asset", parent_id: 10, position: 2 },
    { id: 12, name: "단기", type: "asset", parent_id: 10, position: 1, is_placeholder: true },
    { id: 13, name: "통장", type: "asset", parent_id: 12, position: 1 },
    { id: 14, name: "보관 자산", type: "asset", parent_id: 10, archived: true },
    { id: 15, name: "마이너스", type: "asset", parent_id: 12, position: 2 },
    { id: 20, name: "현금", type: "asset", parent_id: null, position: 1 },
    { id: 30, name: "카드", type: "liability", parent_id: null, position: 1 },
    { id: 40, name: "빈 그룹", type: "asset", parent_id: null, position: 3, is_placeholder: true },
  ].map(a => ({ archived: false, ...a }));
  const amounts = [50, 1000, 25, 2000, 400, -300, 0, -200, 0];
  await page.route("**/api/accounts", r => r.fulfill({ json: grouped }));
  await page.route("**/api/balances?*", r => r.fulfill({ json: {
    net_worth: amounts.reduce((a, b) => a + b, 0), accounts: grouped.map((a, i) => ({
      account_id: a.id, name: a.name, type: a.type,
      reporting_type: a.id === 15 && amounts[i] < 0 ? "liability" : a.type, balance: amounts[i],
    })),
  } }));
  await page.goto("/");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  const assets = page.getByRole("table", { name: "자산 잔액", exact: true });
  const liabilities = page.getByRole("table", { name: "부채 잔액", exact: true });
  await expect(assets.locator(".dashboard-account-cell")).toHaveText(["현금", "직접 잔액", "단기 / 직접 잔액", "단기 / 통장", "통장"]);
  await expect(assets.locator(".balance-subtotal")).toHaveText("생활 자금 소계3,075");
  await expect(liabilities.locator(".balance-subtotal")).toHaveText("생활 자금 소계-300");
  await expect(liabilities.locator(".dashboard-account-cell")).toHaveText(["단기 / 마이너스부채 · 마이너스 사용 중", "카드부채"]);
  await expect(ledger(page).getByText("빈 그룹", { exact: true })).toHaveCount(0);
  await expect(ledger(page).getByText("보관 자산", { exact: true })).toHaveCount(0);
  await expect(ledger(page).locator(".sum")).toContainText("₩2,975");
  amounts[5] = 0;
  await page.reload();
  await expect(assets.getByText("단기 / 마이너스", { exact: true })).toBeVisible();
  await expect(liabilities.getByText("생활 자금", { exact: true })).toHaveCount(0);
  await expect(ledger(page).getByText("마이너스 사용 중", { exact: false })).toHaveCount(0);
  grouped[3].name = "긴계정이름".repeat(20);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(assets.getByText(`단기 / ${grouped[3].name}`, { exact: true })).toBeVisible();
  await expect(assets.locator(".balance-subtotal")).toHaveText("생활 자금 소계3,075");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("balance loading and failure do not look empty; retry recovers", async ({ page }) => {
  await setup(page);
  const pending: Route[] = [];
  await page.route("**/api/balances?*", r => { pending.push(r); });
  await page.goto("/");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await expect(ledger(page).getByText("계정 잔액 확인 중", { exact: true })).toHaveCount(2);
  await expect(ledger(page).locator(".sum")).toContainText("…");
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  for (const route of pending) await route.fulfill({ status: 503, json: { detail: "잔액 조회 실패" } }).catch(() => {});
  await expect(ledger(page).getByRole("alert")).toBeVisible();
  await expect(ledger(page).getByText("계정 잔액을 확인할 수 없습니다", { exact: true })).toHaveCount(2);
  await page.route("**/api/balances?*", r => r.fulfill({ json: balances }));
  await ledger(page).getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("table", { name: "자산 잔액", exact: true }).getByText("사용 통장", { exact: true })).toBeVisible();
  await expect(ledger(page).getByRole("alert")).toHaveCount(0);
});
