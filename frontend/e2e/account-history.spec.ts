import { expect, test, type Page, type Route } from "./test";
import AxeBuilder from "@axe-core/playwright";
import { historyKey, historySearch, readHistoryQuery } from "../src/views/historyQueryState";
import { historyReturn } from "../src/views/transactionEditState";
import { editAccounts } from "./transactionEditFixtures";
import type { Statistics } from "../src/api/statistics";

const base = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
const range = "start=2026-09-01&end=2026-09-30";
const accounts = [...editAccounts.map(a => a.id === 101 ? { ...a, parent_id: 201 } : a),
  { ...editAccounts[0], id: 201, name: "생활비 그룹", is_placeholder: true }];
const txn = { id: 71, scenario_id: 1, date: "2026-09-15", description: "필터 거래", memo: "", tags: [], source_rule_id: null,
  postings: [{ account_id: 101, amount: { amount: 100, currency: "KRW" } }, { account_id: 102, amount: { amount: -100, currency: "KRW" } }] };
const pageBody = { items: [txn], total: 1, page: 1, total_pages: 1, page_size: 100 };
async function mock(page: Page) {
  await page.clock.install({ time: new Date("2026-09-15T03:00:00Z") });
  await page.route("**/api/materialize", r => r.fulfill({ json: { created: 0, transactions: [] } }));
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await page.route("**/api/opening-balances", r => r.fulfill({ json: [] }));
  await page.route("**/api/tags", r => r.fulfill({ json: ["여행"] }));
  await page.route("**/api/transaction-history?*", r => r.fulfill({ json: pageBody }));
}
async function settled(page: Page) {
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await expect(page.locator("#history-result-title")).toContainText("1건");
}

test("account criteria survive URL, keys and edit snapshots; malformed filters never broaden", () => {
  const parsed = readHistoryQuery(new URLSearchParams(`${range}&account_id=201&include_descendants=false&page=2`));
  expect(parsed.query).toMatchObject({ accountId: "201", accountScope: "direct", page: 2 });
  expect(readHistoryQuery(new URLSearchParams(historySearch(parsed.query!))).query).toEqual(parsed.query);
  expect(historyReturn({ query: parsed.query, draft: { ...parsed.draft, tag: "未適用" } }).query).toEqual(parsed.query);
  expect(historyReturn({ query: { ...parsed.query, accountId: 201 } }).query).toBeNull();
  expect(historyKey({ ...parsed.query!, accountScope: "subtree" })).not.toBe(historyKey(parsed.query!));
  expect(historyKey({ ...parsed.query!, accountId: "101" })).not.toBe(historyKey(parsed.query!));
  for (const suffix of ["account_id=", "account_id=0", "account_id=abc", "account_id=01", "account_id=9007199254740992",
    "account_id=101&account_id=102", "include_descendants=false", "account_id=101&include_descendants=no",
    "account_id=101&include_descendants=false&include_descendants=true"]) {
    expect(readHistoryQuery(new URLSearchParams(`${range}&${suffix}`)).query, suffix).toBeUndefined();
  }
});

test("account drafts wait for apply, presets retain them, flow links and Back preserve applied filters", async ({ page }) => {
  await mock(page); const requests: string[] = [];
  await page.route("**/api/transaction-history?*", r => { requests.push(r.request().url()); return r.fulfill({ json: pageBody }); });
  await page.goto(`/transactions?${range}&account_id=201&include_descendants=true`); await settled(page);
  const before = requests.length;
  await page.getByLabel("계정과목", { exact: true }).selectOption("106");
  await page.getByLabel("하위 계정 포함", { exact: true }).uncheck();
  expect(requests).toHaveLength(before);
  await expect(page.getByText("현재 계정: 생활비 그룹 · 하위 계정 포함", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "이번 달", exact: true }).click();
  await expect(page).toHaveURL(/account_id=106&include_descendants=false/);
  await expect(page.getByLabel("계정과목", { exact: true })).toHaveValue("106");
  await expect(page.locator(".history-account-applied")).toContainText("보관계정 (보관)");
  await page.locator(".history-flow").getByRole("link", { name: "식비", exact: true }).click();
  await expect(page).toHaveURL(/account_id=101&include_descendants=false/);
  await page.goBack(); await expect(page).toHaveURL(/account_id=106/);
  await page.getByLabel("계정과목", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page).not.toHaveURL(/account_id|include_descendants/);
});

test("account switch ignores old response; retry uses applied filter; invalid URL never queries", async ({ page }) => {
  await mock(page); let held: Route | undefined;
  await page.route("**/api/transaction-history?*", r => {
    const id = new URL(r.request().url()).searchParams.get("account_id");
    if (id === "101") { held = r; return; }
    return r.fulfill({ json: { ...pageBody, items: [{ ...txn, description: `계정-${id}` }] } });
  });
  await page.goto(`/transactions?${range}&account_id=101`);
  await expect.poll(() => !!held).toBe(true);
  await page.getByLabel("계정과목", { exact: true }).selectOption("102");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page.locator(".history-scroll")).toContainText("계정-102");
  await held!.fulfill({ json: { ...pageBody, items: [{ ...txn, description: "늦은 과거 응답" }] } }).catch(() => {});
  await expect(page.locator(".history-scroll")).not.toContainText("늦은 과거 응답");
  let hits = 0;
  await page.route("**/api/transaction-history?*", r => { hits++; return r.fulfill({ status: 503, json: { detail: "다시 시도" } }); });
  await page.goto(`/transactions?${range}&account_id=106&include_descendants=false`);
  await expect(page.getByRole("alert")).toContainText("불러오지 못했습니다");
  await page.getByLabel("계정과목", { exact: true }).selectOption("101");
  await page.route("**/api/transaction-history?*", r => {
    expect(new URL(r.request().url()).searchParams.get("account_id")).toBe("106");
    return r.fulfill({ json: pageBody });
  });
  await page.getByRole("button", { name: "다시 조회", exact: true }).click();
  await expect(page.locator("#history-result-title")).toContainText("1건");
  await page.route("**/api/transaction-history?*", r => { hits++; return r.fulfill({ json: pageBody }); });
  const before = hits;
  await page.goto(`/transactions?${range}&account_id=bad`);
  await expect(page.getByRole("alert")).toContainText("계정과목"); expect(hits).toBe(before);
});

test("account, dashboard and statistics links expose their period and scope with mobile accessibility", async ({ page }) => {
  await mock(page);
  await page.route("**/api/balances?*", r => r.fulfill({ json: { net_worth: -100, accounts: [{ account_id: 102, name: "현금", type: "asset", reporting_type: "asset", balance: -100, display_balance: -100 }] } }));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: [txn] }));
  await page.route("**/api/rules?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/dashboard-projection?*", r => r.fulfill({ json: { series: [] } }));
  await page.goto("/accounts");
  await expect(page.getByRole("link", { name: "생활비 그룹", exact: true })).toHaveAttribute("href", /start=0001-01-01.*account_id=201&include_descendants=true/);
  await expect(page.getByRole("link", { name: "보관계정", exact: true })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("link", { name: "식비", exact: true })).toHaveAttribute("href", /start=2026-09-01&end=2026-09-30.*account_id=101/);
  await expect(page.getByRole("link", { name: "현금", exact: true })).toHaveAttribute("href", /start=0001-01-01.*account_id=102/);
  const data: Statistics = { start: "2026-09-01", end: "2026-09-15", as_of: "2026-09-15", currency: "KRW", transaction_count: 1, excluded_transaction_count: 0,
    summary: { income: 0, expense: 100, net_income: -100, opening_net_worth: 0, net_worth: -100, net_worth_change: -100, assets: -100, liabilities: 0, capital_change: 0, reconciliation_difference: 0 }, monthly: [], accounts,
    balances: [{ account_id: 101, opening: 0, balance: 100, period: 100, activity: 1, reporting_type: "expense" }, { account_id: 102, opening: 0, balance: -100, period: -100, activity: 1, reporting_type: "asset" }] };
  await page.route("**/api/statistics?*", r => r.fulfill({ json: data }));
  await page.goto(`/statistics?start=${data.start}&end=${data.end}`);
  const expense = page.getByRole("table", { name: "기간 지출 구성", exact: true });
  await expect(expense.getByRole("link", { name: "생활비 그룹", exact: true })).toHaveAttribute("href", /start=2026-09-01.*account_id=201&include_descendants=true/);
  await expect(expense.getByRole("link", { name: "식비", exact: true })).toHaveAttribute("href", /account_id=101&include_descendants=false/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expense.getByRole("link", { name: "식비", exact: true }).click(); await settled(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.getByLabel("계정과목", { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).include(".history-page").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
});

test("real account click, pagination and edit return preserve filter and clamp after account change", async ({ page, request }) => {
  const prefix = `과목조회-${crypto.randomUUID()}`, ids: number[] = [];
  const create = async (name: string, type: string, extra = {}) => {
    const r = await request.post(`${base}/accounts`, { data: { name, type, ...extra } }); expect(r.status()).toBe(201); return (await r.json()).id as number;
  };
  const group = await create(prefix, "expense", { is_placeholder: true });
  const leaf = await create(`${prefix}-하위`, "expense", { parent_id: group });
  const other = await create(`${prefix}-다른`, "expense");
  const bank = await create(`${prefix}-조회통장`, "asset");
  try {
    for (let i = 0; i < 101; i++) {
      const r = await request.post(`${base}/transactions`, { data: { date: "2026-09-15", description: `${prefix}-${i}`, postings: [{ account_id: leaf, amount: 100 }, { account_id: bank, amount: -100 }] } });
      expect(r.status()).toBe(201); ids.push((await r.json()).id);
    }
    await page.goto("/accounts");
    await page.getByRole("link", { name: prefix, exact: true }).click();
    await expect(page.getByLabel("계정과목", { exact: true })).toHaveValue(String(group));
    await expect(page.locator("#history-result-title")).toContainText("101건");
    await page.getByLabel("하위 계정 포함", { exact: true }).uncheck();
    await page.getByRole("button", { name: "조회", exact: true }).click();
    await expect(page.getByText("선택한 기간·태그·계정과목에 해당하는 거래가 없습니다.", { exact: true })).toBeVisible();
    await page.getByLabel("하위 계정 포함", { exact: true }).check();
    await page.getByRole("button", { name: "조회", exact: true }).click();
    await expect(page.locator("#history-result-title")).toContainText("101건");
    await page.getByRole("button", { name: "다음", exact: true }).click();
    await expect(page.locator(".history-scroll tbody tr")).toHaveCount(1);
    await page.getByRole("button", { name: "수정", exact: true }).click();
    await page.getByLabel("메모 (선택)", { exact: true }).fill("계정 필터 복귀 검증");
    await page.getByRole("button", { name: "변경사항 저장", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`account_id=${group}&include_descendants=true&page=2`));
    await expect(page.getByRole("button", { name: "수정", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "수정", exact: true }).click();
    await page.getByRole("group", { name: "차변 계정", exact: true }).getByRole("radio", { name: new RegExp(`${prefix}-다른$`) }).check();
    await page.getByRole("button", { name: "변경사항 저장", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`account_id=${group}&include_descendants=true&page=1`));
    await expect(page.getByText("수정한 거래가 현재 조회 조건에 해당하지 않아 목록에 표시되지 않습니다.", { exact: true })).toBeVisible();
    await expect(page.locator("#history-result-title")).toContainText("100건");
  } finally {
    for (const id of ids) expect((await request.delete(`${base}/transactions/${id}`)).ok()).toBe(true);
  }
});

test("selected account direction uses applied scope, split net amounts and neutral internal transfers", async ({ page }) => {
  await mock(page);
  const rows = [
    { description: "분할 유입", values: [[101, 60], [104, 40], [102, -100]] },
    { description: "환불 유출", values: [[101, -30], [102, 30]] },
    { description: "그룹 내부 이동", values: [[101, -20], [104, 20]] },
    { description: "같은 계정 상계", values: [[101, 50], [101, -20], [102, -30]] },
  ].map((row, i) => ({ ...txn, id: 80 + i, description: row.description,
    postings: row.values.map(([account_id, amount]) => ({ account_id, amount: { amount, currency: "KRW" } })) }));
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts.map(a => a.id === 104 ? { ...a, parent_id: 201, archived: true } : a) }));
  await page.route("**/api/transaction-history?*", r => r.fulfill({ json: { ...pageBody, items: rows, total: rows.length } }));
  await page.goto(`/transactions?${range}&account_id=101&include_descendants=false`);
  const cell = (name: string) => page.locator(".history-scroll tbody tr").filter({ hasText: name }).locator("td.num");
  await expect(cell("분할 유입")).toHaveText("유입 +₩60");
  await expect(cell("분할 유입").locator(".sr-only")).toHaveText("유입");
  expect(await cell("분할 유입").evaluate(el => {
    const visible = el.cloneNode(true) as HTMLElement;
    visible.querySelectorAll(".sr-only").forEach(node => node.remove());
    return visible.textContent;
  })).toBe("+₩60");
  await expect(cell("분할 유입").locator(".history-inflow")).toHaveCSS("color", "rgb(181, 50, 41)");
  await expect(cell("환불 유출")).toHaveText("유출 −₩30");
  await expect(cell("환불 유출").locator(".sr-only")).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
  await expect(cell("환불 유출").locator(".history-outflow")).toHaveCSS("color", "rgb(40, 88, 184)");
  await expect(cell("같은 계정 상계")).toHaveText("유입 +₩30");
  await page.getByLabel("계정과목", { exact: true }).selectOption("102");
  await expect(cell("분할 유입")).toHaveText("유입 +₩60");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(cell("분할 유입")).toHaveText("유출 −₩100");
  await page.getByLabel("계정과목", { exact: true }).selectOption("201");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(cell("분할 유입")).toHaveText("유입 +₩100");
  await expect(cell("그룹 내부 이동").locator(".history-neutral")).toHaveText("변동 없음 ₩0");
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).include(".history-page").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.getByLabel("계정과목", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "조회", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "금액", exact: true })).toBeVisible();
  await expect(cell("분할 유입")).toHaveText("₩100");
  await expect(page.locator(".history-scroll .history-inflow, .history-scroll .history-outflow")).toHaveCount(0);
});

test("selected foreign currency direction preserves native minor units", async ({ page }) => {
  await mock(page);
  await page.route("**/api/transaction-history?*", r => r.fulfill({ json: { ...pageBody,
    items: [{ ...txn, postings: txn.postings.map(p => ({ ...p, amount: { amount: p.amount.amount * 15, currency: "USD" } })) }] } }));
  await page.goto(`/transactions?${range}&account_id=101&include_descendants=false`);
  await expect(page.locator(".history-scroll td.num .history-inflow")).toHaveText("유입 +US$15.00");
});
