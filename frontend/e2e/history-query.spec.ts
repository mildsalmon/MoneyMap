import { expect, test, type Page, type Route, type APIRequestContext } from "./test";
import AxeBuilder from "@axe-core/playwright";
import type { Txn } from "../src/api/types";
import { editAccounts } from "./transactionEditFixtures";

const range = "start=2026-09-01&end=2026-09-30";
const base = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
const submit = (page: Page) => page.getByRole("button", { name: "조회", exact: true });
const rows = (page: Page) => page.locator(".history-scroll tbody tr");
const sample = (id: number, date = "2026-09-15", tags: string[] = []): Txn => ({ id, date, tags, scenario_id: 1,
  description: `거래-${id}`, memo: "", source_rule_id: null,
  postings: [{ account_id: 101, amount: { amount: 100, currency: "KRW" } }, { account_id: 102, amount: { amount: -100, currency: "KRW" } }] });
function pageOf(list: Txn[], url: string) {
  const p = new URL(url).searchParams;
  const filtered = list.filter(t => t.date >= p.get("start")! && t.date <= p.get("end")! && (!p.get("tag") || t.tags.includes(p.get("tag")!)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const total_pages = Math.max(1, Math.ceil(filtered.length / 100)), page = Math.min(Number(p.get("page") ?? 1), total_pages);
  return { items: filtered.slice((page - 1) * 100, page * 100), total: filtered.length, page, total_pages, page_size: 100 };
}
async function mockHistory(page: Page, list: Txn[], tagList = ["데이트", "여행 & Tea"]) {
  const requests: string[] = [];
  await page.route("**/api/accounts", r => r.fulfill({ json: editAccounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: tagList }));
  await page.route("**/api/transaction-history?*", r => { requests.push(r.request().url()); return r.fulfill({ json: pageOf(list, r.request().url()) }); });
  return requests;
}

test("local recent month, defaults URL, presets immediately apply tag drafts and retain future this-month entries", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-13T12:00:00") });
  await mockHistory(page, [sample(1, "2026-08-13"), sample(2, "2026-08-14"), sample(3, "2026-09-13"), sample(4, "2026-09-30", ["데이트"])]);
  await page.goto("/transactions");
  await expect(page).toHaveURL(url => url.searchParams.get("start") === "2026-08-14" && url.searchParams.get("end") === "2026-09-13" && url.searchParams.get("page") === "1");
  await expect(rows(page)).toHaveCount(2);
  await page.getByLabel("태그", { exact: true }).selectOption("데이트");
  await page.getByRole("button", { name: "이번 달", exact: true }).click();
  await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText("거래-4");
  await expect(page).toHaveURL(url => url.searchParams.get("end") === "2026-09-30" && url.searchParams.get("tag") === "데이트");
  await page.clock.setSystemTime(new Date("2026-10-01T12:00:00"));
  await expect(page.getByLabel("종료일", { exact: true })).toHaveValue("2026-09-30");
  await page.getByRole("button", { name: "최근 한 달", exact: true }).click();
  await expect(page.getByLabel("종료일", { exact: true })).toHaveValue("2026-10-01");
});

test("drafts do not fetch, dirty pager locks, Enter applies and pagination replaces exactly 100 rows", async ({ page }) => {
  const requests = await mockHistory(page, Array.from({ length: 201 }, (_, i) => sample(i + 1)));
  await page.goto(`/transactions?${range}&page=1`); await expect(rows(page)).toHaveCount(100);
  const initial = requests.length;
  await page.getByLabel("종료일", { exact: true }).fill("2026-09-29");
  expect(requests).toHaveLength(initial); await expect(page.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "아래는 이전 조회 결과입니다" })).toBeVisible();
  await page.getByLabel("종료일", { exact: true }).press("Enter");
  await expect(page).toHaveURL(url => url.searchParams.get("end") === "2026-09-29");
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("page") === "2");
  await expect(rows(page)).toHaveCount(100); await expect(rows(page).first()).toContainText("거래-101");
  await expect(page.locator("#history-result-title")).toBeFocused();
  await page.getByRole("button", { name: "다음", exact: true }).click();
  await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText("거래-1");
  await expect(page.getByRole("button", { name: "다음", exact: true })).toBeDisabled();
  await expect(page.getByRole("navigation", { name: "거래 페이지" })).toContainText("201–201 / 201건");
});

for (const invalid of ["start=2026-09-01", `${range}&page=0`, `${range}&page=nope`, "start=2026-02-30&end=2026-09-15"]) {
  test(`invalid URL never sends an unbounded request: ${invalid}`, async ({ page }) => {
    const requests = await mockHistory(page, []);
    await page.goto(`/transactions?${invalid}`);
    await expect(page.locator("#history-form-error")).toBeVisible(); expect(requests).toHaveLength(0);
    await page.getByLabel("시작일", { exact: true }).fill("2026-09-01"); await page.getByLabel("종료일", { exact: true }).fill("2026-09-30");
    await submit(page).click(); await expect(page.getByRole("heading", { name: "0건", exact: true })).toBeVisible();
    await expect(page).toHaveURL(url => url.searchParams.get("page") === "1");
  });
}

test("tag catalog failure keeps selected tag and page; retry cannot change draft or fetch transactions", async ({ page }) => {
  const requests = await mockHistory(page, Array.from({ length: 101 }, (_, i) => sample(i + 1, "2026-09-15", ["여행 & Tea"])));
  let fail = true;
  await page.route("**/api/tags", r => fail ? r.fulfill({ status: 500, json: { detail: "목록 실패" } }) : r.fulfill({ json: ["새로운 태그"] }));
  await page.goto(`/transactions?${range}&tag=${encodeURIComponent("여행 & Tea")}&page=2`);
  await expect(rows(page)).toHaveCount(1); await expect(page.getByLabel("태그", { exact: true })).toHaveValue("여행 & Tea");
  await page.getByLabel("종료일", { exact: true }).fill("2026-09-29");
  const count = requests.length, oldRows = await rows(page).allTextContents(); fail = false;
  await page.getByRole("button", { name: "태그 목록 다시 불러오기" }).click();
  await expect(page.getByText("태그 목록을 불러오지 못했습니다.")).toHaveCount(0);
  await expect(page.getByLabel("태그", { exact: true })).toHaveValue("여행 & Tea");
  await expect(page.getByLabel("종료일", { exact: true })).toHaveValue("2026-09-29");
  expect(requests).toHaveLength(count); expect(await rows(page).allTextContents()).toEqual(oldRows);
  await expect(page).toHaveURL(url => url.searchParams.get("page") === "2");
});

test("new request hides old rows through failure; retry uses applied conditions, and older responses cannot win", async ({ page }) => {
  await mockHistory(page, [sample(1)]);
  await page.goto(`/transactions?${range}&page=1`); await expect(rows(page)).toHaveCount(1);
  let held: Route | undefined;
  await page.route("**/api/transaction-history?*", r => { held = r; });
  await page.getByLabel("종료일", { exact: true }).fill("2026-09-29"); await submit(page).click();
  await expect.poll(() => !!held).toBe(true); await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "거래 페이지" })).toHaveCount(0);
  await held!.fulfill({ status: 500, json: { detail: "확인 실패" } });
  await expect(page.locator("#history-query-error")).toBeVisible(); await expect(rows(page)).toHaveCount(0);
  await page.getByLabel("종료일", { exact: true }).fill("2026-09-28"); held = undefined;
  await expect(page.getByText("재시도할 조건: 2026-09-01 ~ 2026-09-29 · 태그 전체 · 1페이지")).toBeVisible();
  await page.getByRole("button", { name: "다시 조회", exact: true }).click();
  await expect.poll(() => !!held).toBe(true);
  expect(new URL(held!.request().url()).searchParams.get("end")).toBe("2026-09-29");
  const old = held!; held = undefined;
  await submit(page).click(); await expect.poll(() => !!held).toBe(true);
  await held!.fulfill({ json: pageOf([sample(2)], held!.request().url()) });
  await expect(rows(page)).toContainText("거래-2");
  await old.fulfill({ json: pageOf([sample(1)], old.request().url()) }).catch(() => {});
  await expect(rows(page)).toContainText("거래-2"); await expect(rows(page)).not.toContainText("거래-1");
});

test("delete rejects duplicate clicks and reports response loss without replay or false success", async ({ page }) => {
  const list = [sample(1), sample(2)];
  await mockHistory(page, list);
  await page.goto(`/transactions?${range}&page=1`); await expect(rows(page)).toHaveCount(2);
  let deletes = 0, held: Route | undefined;
  await page.route("**/api/transactions/2", r => { deletes++; held = r; });
  page.on("dialog", d => d.accept());
  await rows(page).first().getByRole("button", { name: "삭제", exact: true }).click();
  await expect.poll(() => deletes).toBe(1); await expect(rows(page).last().getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await held!.abort("failed"); await expect(page.getByText("삭제 결과를 확인할 수 없습니다. 목록을 다시 조회해 주세요.")).toBeVisible();
  await page.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(rows(page)).toHaveCount(2); expect(deletes).toBe(1);
  await expect(page.getByText("거래를 삭제했습니다.", { exact: true })).toHaveCount(0);
  await expect(rows(page).first().getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  const other = rows(page).last().getByRole("button", { name: "삭제", exact: true });
  await expect(other).toBeEnabled();
  await page.route("**/api/transactions/1", r => { list.shift(); return r.fulfill({ json: { deleted: 1 } }); });
  await other.click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("거래-2 (#2)");
  // Query-key remounts and another successful delete cannot drop protection.
  await page.getByLabel("종료일", { exact: true }).fill("2026-09-29"); await submit(page).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  expect(deletes).toBe(1);
});

test("several uncertain deletes retain each target and survive a failed recovery read", async ({ page }) => {
  await mockHistory(page, [sample(1), sample(2), sample(3)]);
  await page.goto(`/transactions?${range}&page=1`); await expect(rows(page)).toHaveCount(3);
  let deletes = 0;
  await page.route(/\/api\/transactions\/[23]$/, r => { deletes++; return r.abort(); });
  page.on("dialog", d => d.accept());
  await rows(page).nth(0).getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("거래-3 (#3)");
  await rows(page).nth(1).getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("거래-2 (#2)");
  await expect(page.getByRole("alert")).toContainText("거래-3 (#3)");
  await page.route("**/api/transaction-history?*", r => r.fulfill({ status: 500, json: { detail: "조회 실패" } }));
  await page.getByRole("button", { name: "목록 다시 조회" }).click();
  await expect(page.locator("#history-query-error")).toBeVisible();
  await expect(rows(page)).toHaveCount(0); expect(deletes).toBe(2);
});

test("delete cancel and explicit refusal preserve rows, then successful delete reaches zero", async ({ page }) => {
  const list = [sample(1)]; await mockHistory(page, list);
  await page.goto(`/transactions?${range}&page=1`); await expect(rows(page)).toHaveCount(1);
  let deletes = 0;
  await page.route("**/api/transactions/1", r => { deletes++; return deletes === 1
    ? r.fulfill({ status: 404, json: { detail: { code: "transaction_not_found", message: "없음" } } })
    : (list.pop(), r.fulfill({ json: { deleted: 1 } })); });
  page.once("dialog", d => d.dismiss()); await rows(page).getByRole("button", { name: "삭제", exact: true }).click();
  expect(deletes).toBe(0); page.on("dialog", d => d.accept());
  await rows(page).getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByText("삭제하지 못했습니다. 없음")).toBeVisible(); await expect(rows(page)).toHaveCount(1);
  await rows(page).getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByRole("heading", { name: "0건", exact: true })).toBeVisible(); expect(deletes).toBe(2);
});

test("mobile uses shared column order, named controls and table-only overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockHistory(page, [{ ...sample(1), description: "긴내역".repeat(50), memo: "메모".repeat(200) }]);
  await page.goto(`/transactions?${range}&page=1`); await expect(rows(page)).toHaveCount(1);
  expect(await page.locator("th").allTextContents()).toEqual(["날짜", "내역", "금액", "흐름", "작업"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await submit(page).evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.getByText("메모 보기", { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const results = await new AxeBuilder({ page }).include(".history-page").analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("history-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("history-desktop.png"), fullPage: true });
});

test("late tag choices do not change form height or a scrolled ledger position", async ({ page }) => {
  await mockHistory(page, Array.from({ length: 201 }, (_, i) => sample(i + 1, "2026-09-15", ["데이트"])));
  let held: Route | undefined;
  await page.route("**/api/tags", r => { held = r; });
  await page.goto(`/transactions?${range}&tag=${encodeURIComponent("데이트")}&page=2`);
  await expect(rows(page)).toHaveCount(100); await expect.poll(() => !!held).toBe(true);
  await rows(page).last().scrollIntoViewIfNeeded();
  const height = await page.locator(".history-query").evaluate(e => e.getBoundingClientRect().height);
  const scroll = await page.locator(".main").evaluate(e => e.scrollTop); expect(scroll).toBeGreaterThan(0);
  await held!.fulfill({ json: ["데이트", "새 태그"] });
  await expect(page.getByText("목록 확인 중…", { exact: true })).toHaveCount(0);
  expect(await page.locator(".history-query").evaluate(e => e.getBoundingClientRect().height)).toBe(height);
  await expect.poll(() => page.locator(".main").evaluate(e => e.scrollTop)).toBe(scroll);
});

async function createLedger(request: APIRequestContext, count: number) {
  const tag = `기간-${crypto.randomUUID()}`, accounts = [];
  for (const type of ["asset", "expense"]) {
    const response = await request.post(`${base}/accounts`, { data: { name: `${tag}-${type}`, type } });
    expect(response.ok()).toBeTruthy(); accounts.push(await response.json());
  }
  const txns = [];
  for (let i = 0; i < count; i++) {
    const response = await request.post(`${base}/transactions`, { data: { date: "2026-09-15", description: `${tag}-${i}`, tags: [tag],
      postings: [{ account_id: accounts[0].id, amount: -100 }, { account_id: accounts[1].id, amount: 100 }] } });
    expect(response.ok()).toBeTruthy(); txns.push(await response.json());
  }
  return { tag, txns };
}

for (const scenario of [
  { name: "moves to another page", count: 201, date: "2026-09-30", page: "2", outside: false },
  { name: "leaves the date range", count: 201, date: "2026-10-01", page: "2", outside: true },
  { name: "leaves the date range and removes the last page", count: 101, date: "2026-10-01", page: "1", outside: true },
]) {
  test(`date-only edit ${scenario.name} preserves query and explains the result`, async ({ page, request }) => {
    const { tag, txns } = await createLedger(request, scenario.count);
    try {
      await page.goto(`/transactions?${range}&tag=${encodeURIComponent(tag)}&page=2`);
      const edited = scenario.count === 201 ? txns[10] : txns[0];
      await page.locator(`#edit-transaction-${edited.id}`).click();
      await page.getByLabel("날짜", { exact: true }).fill(scenario.date);
      await page.getByRole("button", { name: "변경사항 저장", exact: true }).click();
      await expect(page).toHaveURL(url => url.searchParams.get("page") === scenario.page
        && url.searchParams.get("start") === "2026-09-01" && url.searchParams.get("end") === "2026-09-30" && url.searchParams.get("tag") === tag);
      await expect(page.locator("#history-result-title")).toBeFocused();
      await expect(page.locator(`#edit-transaction-${edited.id}`)).toHaveCount(0);
      await expect(page.getByText(scenario.outside
        ? "수정한 거래가 현재 조회 조건에 해당하지 않아 목록에 표시되지 않습니다."
        : "수정한 거래가 다른 페이지로 이동했거나 현재 조회 결과에 없습니다. 현재 페이지를 유지했습니다.", { exact: true })).toBeVisible();
      if (scenario.page === "1") {
        await expect(page.getByText("마지막 유효 페이지로 이동했습니다.", { exact: true })).toBeVisible();
        await expect.poll(() => page.locator(".main").evaluate(e => e.scrollTop)).toBe(0);
      }
      const saved = await (await request.get(`${base}/transactions/${edited.id}`)).json();
      expect(saved).toMatchObject({ id: edited.id, date: scenario.date, tags: [tag] });
    } finally { for (const txn of txns) await request.delete(`${base}/transactions/${txn.id}`); }
  });
}

test("real API page-two edit preserves query, draft, ledger identity and scroll; last-page deletion clamps", async ({ page, request }) => {
  const { tag, txns } = await createLedger(request, 201);
  try {
    await page.goto(`/transactions?${range}&tag=${encodeURIComponent(tag)}&page=2`);
    await expect(rows(page)).toHaveCount(100);
    const target = txns[10], button = page.locator(`#edit-transaction-${target.id}`);
    await page.getByLabel("종료일", { exact: true }).fill("2026-09-29");
    await button.scrollIntoViewIfNeeded(); const scroll = await page.locator(".main").evaluate(e => e.scrollTop); expect(scroll).toBeGreaterThan(0);
    await button.click(); await page.getByLabel("메모 (선택)", { exact: true }).fill("수정 후 같은 페이지");
    await page.getByRole("button", { name: "변경사항 저장", exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get("page") === "2" && url.searchParams.get("end") === "2026-09-30" && url.searchParams.get("tag") === tag);
    await expect(button).toBeFocused(); await expect.poll(() => page.locator(".main").evaluate(e => e.scrollTop)).toBe(scroll);
    await expect(page.getByLabel("종료일", { exact: true })).toHaveValue("2026-09-29");
    const persisted = await (await request.get(`${base}/transactions/${target.id}`)).json();
    expect(persisted).toMatchObject({ id: target.id, memo: "수정 후 같은 페이지" });
    await page.getByLabel("종료일", { exact: true }).fill("2026-09-30");
    await page.getByRole("button", { name: "다음", exact: true }).click(); await expect(rows(page)).toHaveCount(1);
    page.once("dialog", d => d.accept()); await rows(page).getByRole("button", { name: "삭제", exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get("page") === "2");
    await expect(rows(page)).toHaveCount(100); await expect(page.getByText("마지막 유효 페이지로 이동했습니다.")).toBeVisible();
    await expect(page.locator("#history-result-title")).toBeFocused();
    expect((await request.get(`${base}/transactions/${txns[0].id}`)).status()).toBe(404);
    await page.reload(); await expect(rows(page)).toHaveCount(100);
    await expect(page).toHaveURL(url => url.searchParams.get("page") === "2");
    // Applying a new query after edit return must not re-use the old offset.
    await submit(page).click();
    await expect(page).toHaveURL(url => url.searchParams.get("page") === "1");
    await expect(page.locator("#history-result-title")).toBeFocused();
    await expect.poll(() => page.locator(".main").evaluate(e => e.scrollTop)).toBe(0);
  } finally { for (const t of txns) await request.delete(`${base}/transactions/${t.id}`); }
});

for (const [timezoneId, time, day, start] of [
  ["Asia/Seoul", "2026-09-14T15:30:00Z", "2026-09-15", "2026-08-16"],
  ["America/Los_Angeles", "2026-09-15T00:30:00Z", "2026-09-14", "2026-08-15"],
]) {
  test.describe(`local calendar in ${timezoneId}`, () => {
    test.use({ timezoneId });
    test("uses local today when UTC is a different date", async ({ page }) => {
      await page.clock.install({ time: new Date(time) }); await mockHistory(page, []);
      await page.goto("/transactions");
      await expect(page).toHaveURL(url => url.searchParams.get("start") === start && url.searchParams.get("end") === day);
    });
  });
}

test("real delete response loss keeps uncertainty even if reread shows no row", async ({ page, request }) => {
  const { tag, txns } = await createLedger(request, 1); let deletes = 0;
  try {
    await page.goto(`/transactions?${range}&tag=${encodeURIComponent(tag)}&page=1`); await expect(rows(page)).toHaveCount(1);
    await page.route(`**/api/transactions/${txns[0].id}`, async r => { deletes++; expect((await r.fetch()).ok()).toBeTruthy(); await r.abort(); });
    page.once("dialog", d => d.accept()); await rows(page).getByRole("button", { name: "삭제", exact: true }).click();
    await expect(page.getByText("삭제 결과를 확인할 수 없습니다. 목록을 다시 조회해 주세요.")).toBeVisible();
    await page.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
    await expect(page.getByRole("heading", { name: "0건", exact: true })).toBeVisible();
    await expect(page.getByText("삭제 결과를 확인할 수 없습니다. 목록을 다시 조회해 주세요.")).toBeVisible();
    expect(deletes).toBe(1);
  } finally { await request.delete(`${base}/transactions/${txns[0].id}`); }
});
