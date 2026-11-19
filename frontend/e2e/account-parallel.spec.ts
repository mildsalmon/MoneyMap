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

test("최상위 분류 저장 중에도 다른 유형의 초안과 고급 계정 추가를 사용할 수 있다", async ({ page, request }) => {
  const prefix = "유형별-" + Date.now();
  const group = await request.post(api + "/accounts", { data: { name: prefix, type: "expense", is_placeholder: true } });
  expect(group.status()).toBe(201);
  const parent: Account = await group.json();
  const pending = gate();
  await page.route("**/api/accounts", async route => {
    if (route.request().method() === "POST" && route.request().postDataJSON().name === prefix + "-자산") await pending.wait;
    await route.continue();
  });
  await page.goto("/accounts");
  const section = (name: string) => page.locator(".account-section").filter({ has: page.getByText(name, { exact: true }) });
  try {
    await section("자산").getByRole("button", { name: "새 분류" }).click();
    const asset = page.getByLabel("자산 새 분류 이름");
    await asset.fill(prefix + "-자산");
    await asset.press("Enter");
    await section("부채").getByRole("button", { name: "새 분류" }).click();
    const liability = page.getByLabel("부채 새 분류 이름");
    await liability.fill(prefix + "-초안");
    await page.getByText("고급", { exact: true }).click();
    await page.getByLabel("유형", { exact: true }).selectOption("expense");
    await page.getByLabel("상위 그룹 (선택)").selectOption(String(parent.id));
    await page.getByLabel("계정 이름", { exact: true }).fill(prefix + "-비용");
    await page.getByRole("button", { name: "계정 추가", exact: true }).click();
    await expect(page.getByRole("link", { name: prefix + "-비용", exact: true })).toBeVisible();
    pending.release();
    await expect(page.getByRole("link", { name: prefix + "-자산", exact: true })).toBeVisible();
    await expect(liability).toHaveValue(prefix + "-초안");
    expect((await serverRows(request, parent)).map(row => row.name)).toEqual([prefix + "-비용"]);
  } finally { pending.release(); }
});

test.describe("리뷰 회귀", () => {
  test("새로고침 후에도 타 탭에서 이름이 바뀐 생성 요청의 영수증을 확인한다", async ({ page, context, request }) => {
    const { parent } = await group(request, "생성복구");
    const original = parent.name + "-신규", renamed = original + "-변경";
    const input = page.getByLabel(parent.name + " 소분류 이름");
    const alert = page.locator("tr.account-inline [role=alert]");
    async function enterDraft() {
      await row(page, parent).getByRole("button", { name: /더보기$/ }).click();
      await page.getByRole("menuitem", { name: "소분류" }).click();
      await input.fill(original);
      await input.press("Enter");
    }
    const posts: string[] = [], receipts: string[] = [];
    let receiptAvailable = false;
    await page.route("**/accounts/creation-requests/*", async route => {
      receipts.push(route.request().url().split("/").pop()!);
      if (receiptAvailable) await route.continue();
      else await route.abort();
    });
    await page.route("**/api/accounts", async route => {
      if (route.request().method() === "POST") {
        posts.push(route.request().postDataJSON().request_id);
        if (posts.length === 1) {
          expect((await route.fetch()).status()).toBe(201);
          await route.abort();
          return;
        }
      }
      await route.continue();
    });
    await page.goto("/accounts");
    await enterDraft();
    await expect(alert).toBeVisible();
    const saved = (await serverRows(request, parent)).find(a => a.name === original)!;
    const other = await context.newPage();
    await blockExternalStyles(other);
    await other.goto("/accounts");
    await settings(other, saved).click();
    await form(other, saved).getByLabel(original + " 이름").fill(renamed);
    await form(other, saved).getByRole("button", { name: "변경 저장" }).click();
    await expect(row(other, saved)).toContainText(renamed);

    await page.reload();
    await enterDraft();
    await expect.poll(() => receipts.length + posts.length).toBe(3);
    expect(posts).toHaveLength(1);
    await expect(alert).toBeVisible();
    receiptAvailable = true;
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    expect(receipts).toEqual([posts[0], posts[0], posts[0]]);
    expect((await serverRows(request, parent)).filter(a => a.name.startsWith(original)))
      .toMatchObject([{ id: saved.id, name: renamed }]);

    // After confirmation, a deliberate new account with the old name is a new command.
    await enterDraft();
    await expect(input).toHaveCount(0);
    expect(new Set(posts).size).toBe(2);
  });

  test("먼저 시작한 설정의 뒤늦은 확인은 나중에 저장한 순서의 실행취소를 보존한다", async ({ page, request }) => {
    const a = await group(request, "확인A"), b = await group(request, "실행취소B");
    await page.goto("/accounts");
    const panel = form(page, a.first);
    await settings(page, a.first).click();
    await panel.getByLabel(a.first.name + " 이름").fill(a.first.name + "-완료");
    await page.route(`**/accounts/${a.first.id}/settings`, async route => {
      expect((await route.fetch()).status()).toBe(200);
      await route.abort();
    });
    await panel.getByRole("button", { name: "변경 저장" }).click();
    const check = panel.getByRole("button", { name: "최신 내용 확인" });
    await expect(check).toBeVisible();
    await moveUp(page, b.second);
    await expect(page.locator(".toast")).toContainText(b.second.name);
    await check.click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".toast")).toContainText(b.second.name);
    await page.getByRole("button", { name: "실행취소", exact: true }).click();
    await expect.poll(async () => (await serverRows(request, b.parent)).map(r => r.id))
      .toEqual([b.first.id, b.second.id]);
    expect((await serverRows(request, a.parent))[0].name).toBe(a.first.name + "-완료");
  });

  test("설정 저장 중 접힌 독립 그룹을 펼쳐 저장하고 겹치는 그룹은 잠근다", async ({ page, request }) => {
    const a = await group(request, "펼침A"), b = await group(request, "펼침B");
    const pending = gate();
    await page.route(`**/accounts/${a.first.id}/settings`, async route => {
      await pending.wait;
      await route.continue();
    });
    await page.goto("/accounts");
    await row(page, b.parent).getByRole("button", { name: /하위 계정 접기/ }).click();
    try {
      await settings(page, a.first).click();
      await form(page, a.first).getByLabel(a.first.name + " 이름").fill(a.first.name + "-완료");
      await form(page, a.first).getByRole("button", { name: "변경 저장" }).click();
      await expect(row(page, a.parent).getByRole("button", { name: /하위 계정 접기/ })).toBeDisabled();
      await expect(settings(page, a.second)).toBeDisabled();
      const expand = row(page, b.parent).getByRole("button", { name: /하위 계정 펼치기/ });
      await expect(expand).toBeEnabled();
      await expand.press("Enter");
      await settings(page, b.first).click();
      await form(page, b.first).getByLabel(b.first.name + " 이름").fill(b.first.name + "-완료");
      await form(page, b.first).getByRole("button", { name: "변경 저장" }).click();
      await expect(row(page, b.first)).toContainText(b.first.name + "-완료");
      await expect(settings(page, a.second)).toBeDisabled();
      pending.release();
      await expect(row(page, a.first)).toContainText(a.first.name + "-완료");
    } finally { pending.release(); }
  });
});
