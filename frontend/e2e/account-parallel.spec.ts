import { expect, test, blockExternalStyles, type APIRequestContext, type Page } from "./test";
import type { Account } from "../src/api";

const api = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
const row = (page: Page, account: Account) => page.locator(`.account-row[data-order-row="${account.id}"]`);
const settings = (page: Page, account: Account) => row(page, account).getByRole("button", { name: "설정", exact: true });
const form = (page: Page, account: Account) => page.locator(`#account-settings-panel-${account.id}`);
async function group(request: APIRequestContext, label: string) {
  const prefix = `${label}-${Date.now()}`;
  async function create(name: string, parent_id: number | null): Promise<Account> {
    const response = await request.post(`${api}/accounts`, { data: { type: "asset", name: prefix + name, parent_id } });
    expect(response.status()).toBe(201);
    return response.json();
  }
  const parent = await create("-그룹", null);
  return { parent, first: await create("-1", parent.id), second: await create("-2", parent.id) };
}
async function serverRows(request: APIRequestContext, parent: Account): Promise<Account[]> {
  const rows: Account[] = await (await request.get(`${api}/accounts`)).json();
  return rows.filter(a => a.parent_id === parent.id).sort((a, b) => a.position - b.position);
}
async function moveUp(page: Page, account: Account) {
  await page.getByRole("button", { name: account.name + " 순서 변경", exact: true }).click();
  await page.getByRole("button", { name: account.name + " 위로 이동", exact: true }).click();
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
async function visibleOrder(page: Page, ids: number[]) {
  return page.locator(".account-row").evaluateAll((rows, wanted) =>
    rows.map(r => Number(r.getAttribute("data-order-row"))).filter(id => wanted.includes(id)), ids);
}

for (const committed of [true, false]) {
  test(`A 순서 지연 중 B 추가 응답 유실과 재시도 · 서버 반영 ${committed}`, async ({ page, request }) => {
    const a = await group(request, "순서"), b = await group(request, "추가");
    const desired = [a.second.id, a.first.id];
    const childName = b.parent.name + "-신규";
    const orderGate = gate(), readGate = gate(), readStarted = gate();
    let posts = 0, receipts = 0, holdRead = false;
    await page.goto("/accounts");
    await expect(row(page, b.parent)).toBeVisible();
    await page.route("**/accounts/reorder", async route => {
      await orderGate.wait;
      await route.continue();
    });
    await page.route("**/accounts/creation-requests/*", async route => {
      if (++receipts === 1) await route.abort();
      else await route.continue();
    });
    await page.route("**/api/accounts", async route => {
      if (route.request().method() === "POST" && ++posts === 1) {
        if (committed) expect((await route.fetch()).status()).toBe(201);
        await route.abort();
      } else if (route.request().method() === "GET" && holdRead) {
        holdRead = false;
        const snapshot = await route.fetch();
        readStarted.release();
        await readGate.wait;
        await route.fulfill({ response: snapshot });
      } else await route.continue();
    });
    try {
      await moveUp(page, a.second);
      await expect(settings(page, a.first)).toBeDisabled();
      await expect(settings(page, a.parent)).toBeDisabled();
      await row(page, b.parent).getByRole("button", { name: /더보기$/ }).click();
      await page.getByRole("menuitem", { name: "소분류" }).click();
      const input = page.getByLabel(b.parent.name + " 소분류 이름");
      await input.fill(childName);
      const draft = page.locator("tr.account-inline").filter({ has: input });
      await draft.getByRole("button", { name: "저장" }).click();
      await expect(draft.getByRole("alert")).toBeVisible();
      holdRead = true;
      await draft.getByRole("button", { name: "저장" }).click();
      await readStarted.wait;
      expect(posts).toBe(committed ? 1 : 2);
      expect(receipts).toBe(2);
      await expect.poll(() => visibleOrder(page, desired)).toEqual(desired);
      expect((await serverRows(request, a.parent)).map(a => a.id)).toEqual([...desired].reverse());
      expect((await serverRows(request, b.parent)).filter(a => a.name === childName)).toHaveLength(1);
      orderGate.release();
      await expect(settings(page, a.first)).toBeEnabled();
      const staleRead = page.waitForResponse(r => r.url() === api + "/accounts" && r.request().method() === "GET");
      readGate.release();
      await staleRead;
      await expect.poll(() => visibleOrder(page, desired)).toEqual(desired);
      await expect(page.getByRole("button", { name: "실행취소" })).toHaveCount(0);
      expect((await serverRows(request, a.parent)).map(a => a.id)).toEqual(desired);
      await page.reload();
      await expect.poll(() => visibleOrder(page, desired)).toEqual(desired);
      await expect(page.getByRole("link", { name: childName, exact: true })).toHaveCount(1);
    } finally { orderGate.release(); readGate.release(); }
  });
}

test("두 설정 패널에서 독립 저장하고 다른 탭의 수정과 충돌하면 최신 필드를 보존한 뒤 재시도한다", async ({ page, context, request }) => {
  const a = await group(request, "설정A"), b = await group(request, "설정B");
  const aName = a.first.name + "-수정", bName = b.first.name + "-수정";
  await page.goto("/accounts");
  await settings(page, a.first).click();
  await settings(page, b.first).click();
  await form(page, a.first).getByLabel(a.first.name + " 이름").fill(aName);
  await form(page, b.first).getByLabel(b.first.name + " 이름").fill(bName);
  const other = await context.newPage();
  await blockExternalStyles(other);
  await other.goto("/accounts");
  await settings(other, b.first).click();
  await form(other, b.first).getByLabel(/현금 부족 계산/).check();
  await form(other, b.first).getByRole("button", { name: "변경 저장" }).click();
  await expect(form(other, b.first)).toHaveCount(0);
  const pending = gate();
  await page.route(`**/accounts/${a.first.id}/settings`, async route => {
    await pending.wait;
    await route.continue();
  });
  try {
    await form(page, a.first).getByRole("button", { name: "변경 저장" }).click();
    await expect(settings(page, a.second)).toBeDisabled();
    const panel = form(page, b.first);
    const stale = page.waitForResponse(r => r.url().endsWith(`/${b.first.id}/settings`) && r.status() === 409);
    await panel.getByRole("button", { name: "변경 저장" }).click();
    await stale;
    await panel.getByRole("button", { name: "최신 내용 확인" }).click();
    await expect(panel.getByLabel(/현금 부족 계산/)).toBeChecked();
    await expect(panel.getByLabel(b.first.name + " 이름")).toHaveValue(bName);
    await panel.getByRole("button", { name: "변경 저장" }).click();
    await expect(row(page, b.first)).toContainText(bName);
    pending.release();
    await expect(row(page, a.first)).toContainText(aName);
    await page.reload();
    await expect(row(page, a.first)).toContainText(aName);
    await expect(row(page, b.first)).toContainText(bName);
    expect((await serverRows(request, b.parent))[0]).toMatchObject({ name: bName, include_in_cash: true });
    expect((await serverRows(request, a.parent))[0].name).toBe(aName);
  } finally { pending.release(); }
});

test("두 순서 저장이 역순으로 응답해도 나중에 조작한 그룹만 실행 취소한다", async ({ page, request }) => {
  const a = await group(request, "이동A"), b = await group(request, "이동B");
  const pending = gate();
  await page.route("**/accounts/reorder", async route => {
    if (route.request().postDataJSON().parent_id === a.parent.id) await pending.wait;
    await route.continue();
  });
  await page.goto("/accounts");
  try {
    await moveUp(page, a.second);
    await moveUp(page, b.second);
    await expect(page.locator(".toast")).toContainText(b.second.name);
    pending.release();
    await expect(settings(page, a.first)).toBeEnabled();
    await expect(page.locator(".toast")).toContainText(b.second.name);
    await page.getByRole("button", { name: "실행취소" }).click();
    await expect(page.locator(".toast")).toContainText("취소했습니다");
    expect((await serverRows(request, a.parent)).map(r => r.id)).toEqual([a.second.id, a.first.id]);
    expect((await serverRows(request, b.parent)).map(r => r.id)).toEqual([b.first.id, b.second.id]);
  } finally { pending.release(); }
});

test("상위 그룹 이동은 출발·도착·하위 쓰기만 막고 유실된 저장 결과는 재조회로 확정한다", async ({ page, request }) => {
  const a = await group(request, "출발"), b = await group(request, "도착"), c = await group(request, "독립");
  const response = await request.post(`${api}/accounts`, { data: {
    name: a.first.name + "-하위", type: "asset", parent_id: a.first.id,
  } });
  expect(response.status()).toBe(201);
  const nested = await response.json();
  await page.goto("/accounts");
  await settings(page, a.first).click();
  const panel = form(page, a.first);
  await panel.getByLabel(a.first.name + " 상위 그룹").selectOption(String(b.parent.id));
  const pending = gate();
  let puts = 0;
  await page.route(`**/accounts/${a.first.id}/settings`, async route => {
    puts++;
    await pending.wait;
    expect((await route.fetch()).ok()).toBeTruthy();
    await route.abort();
  });
  try {
    await panel.getByRole("button", { name: "변경 저장" }).click();
    for (const account of [a.second, b.first, nested]) await expect(settings(page, account)).toBeDisabled();
    await expect(settings(page, c.first)).toBeEnabled();
    pending.release();
    await panel.getByRole("button", { name: "최신 내용 확인" }).click();
    await expect(panel).toHaveCount(0);
    expect(puts).toBe(1);
    expect((await serverRows(request, b.parent)).map(r => r.id)).toContain(a.first.id);
    expect((await serverRows(request, a.parent)).map(r => r.id)).toEqual([a.second.id]);
  } finally { pending.release(); }
});
