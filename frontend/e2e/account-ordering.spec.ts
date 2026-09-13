import { test, expect, type APIRequestContext, type Page } from "./test";

const base = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
let serial = 0;
async function fixture(request: APIRequestContext) {
  const prefix = `order-${Date.now()}-${serial++}`;
  const create = async (name: string, parent_id: number | null, is_placeholder = false) => {
    const result = await request.post(`${base}/accounts`, { data: { name: `${prefix}-${name}`, type: "expense", parent_id, is_placeholder } });
    expect(result.ok()).toBeTruthy(); return result.json();
  };
  const root = await create("root", null, true);
  const a = await create("A", root.id, true), child = await create("child", a.id);
  const b = await create("B", root.id), c = await create("C", root.id);
  return { root, a, b, c, child };
}
async function open(page: Page) { await page.goto("/accounts"); await expect(page.locator(".accounts-ledger")).toBeVisible(); }
async function ids(page: Page, wanted: number[]) {
  return page.locator(".account-row[data-order-row]").evaluateAll((rows, wanted) => rows.map(r => Number(r.getAttribute("data-order-row"))).filter(id => wanted.includes(id)), wanted);
}
test("button reorder persists, undo restores, and consumers use tree order", async ({ page, request }) => {
  const f = await fixture(request); await open(page);
  const wanted = [f.a.id, f.child.id, f.b.id, f.c.id];
  await page.getByRole("button", { name: `${f.b.name} 순서 변경`, exact: true }).click();
  await page.getByRole("button", { name: `${f.b.name} 위로 이동`, exact: true }).click();
  await expect.poll(() => ids(page, wanted)).toEqual([f.b.id, f.a.id, f.child.id, f.c.id]);
  await expect(page.locator(".toast")).toContainText("순서 변경됨");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect.poll(() => ids(page, wanted)).toEqual(wanted);
  await page.reload(); await expect.poll(() => ids(page, wanted)).toEqual(wanted);
  await page.getByRole("button", { name: "반복 규칙", exact: true }).click();
  const options = page.getByLabel("어디서 (from)", { exact: true }).locator("option");
  await expect.poll(() => options.evaluateAll((nodes, wanted) => nodes.map(n => Number((n as HTMLOptionElement).value)).filter(id => wanted.includes(id)), [f.child.id, f.b.id, f.c.id]))
    .toEqual([f.child.id, f.b.id, f.c.id]);
});
test("handle drag moves group and descendants, cross-parent drop is ignored", async ({ page, request }) => {
  const f = await fixture(request); await open(page);
  const grip = page.getByRole("button", { name: `${f.a.name} 순서 변경`, exact: true });
  await grip.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
  const from = (await grip.boundingBox())!;
  const to = (await page.locator(`.account-row[data-order-row="${f.c.id}"]`).boundingBox())!;
  await page.mouse.move(from.x + 16, from.y + 16); await page.mouse.down();
  await page.mouse.move(to.x + 70, to.y + to.height - 3, { steps: 15 });
  await expect(page.getByTestId("order-insertion")).toBeVisible();
  // The drag overlay must not change document height or shift the target row.
  expect((await page.locator(`.account-row[data-order-row="${f.c.id}"]`).boundingBox())!.y).toBeCloseTo(to.y, 0);
  await page.mouse.up();
  await expect.poll(() => ids(page, [f.a.id, f.child.id, f.b.id, f.c.id])).toEqual([f.b.id, f.c.id, f.a.id, f.child.id]);
  await expect(page.locator(".toast")).toContainText("순서 변경됨");
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect.poll(() => ids(page, [f.a.id, f.child.id, f.b.id, f.c.id])).toEqual([f.a.id, f.child.id, f.b.id, f.c.id]);
  const bGrip = page.getByRole("button", { name: `${f.b.name} 순서 변경`, exact: true });
  await bGrip.scrollIntoViewIfNeeded(); const bBox = (await bGrip.boundingBox())!;
  const rootBox = (await page.locator(`.account-row[data-order-row="${f.root.id}"]`).boundingBox())!;
  let writes = 0; page.on("request", r => { if (r.url().endsWith("/accounts/reorder")) writes++; });
  await page.mouse.move(bBox.x + 16, bBox.y + 16); await page.mouse.down();
  await page.mouse.move(rootBox.x + 70, rootBox.y + 4, { steps: 10 });
  await expect(page.getByTestId("order-insertion")).toHaveCount(0); await page.mouse.up();
  expect(writes).toBe(0);
});
test("typed conflict and failed recovery keep persistent retry", async ({ page, request }) => {
  const f = await fixture(request); await open(page);
  await page.route("**/api/accounts/reorder", route => route.fulfill({ status: 409, json: { detail: { code: "account_reorder_stale", message: "stale" } } }));
  await page.route("**/api/accounts", route => route.abort());
  await page.getByRole("button", { name: `${f.b.name} 순서 변경`, exact: true }).click();
  await page.getByRole("button", { name: `${f.b.name} 위로 이동`, exact: true }).click();
  await expect(page.getByRole("button", { name: "다시 불러오기", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `${f.a.name} 순서 변경`, exact: true })).toBeDisabled();
  await page.unroute("**/api/accounts");
  await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await expect(page.getByRole("button", { name: `${f.a.name} 순서 변경`, exact: true })).toBeEnabled();
  await expect.poll(() => ids(page, [f.a.id, f.b.id, f.c.id])).toEqual([f.a.id, f.b.id, f.c.id]);
});
test("mobile uses 44px buttons and preserves the moved account focus", async ({ page, request }) => {
  const f = await fixture(request); await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  const button = page.getByRole("button", { name: `${f.b.name} 위로 이동`, exact: true });
  await button.scrollIntoViewIfNeeded(); const box = (await button.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  await button.click(); await expect(button).toBeDisabled();
  await expect(page.getByRole("button", { name: `${f.b.name} 아래로 이동`, exact: true })).toBeFocused();
});

for (const outcome of ["desired", "previous", "other"] as const) {
  test(`ambiguous response reconciles ${outcome} without unsafe undo`, async ({ page, request }) => {
    const f = await fixture(request); await open(page);
    await page.route("**/api/accounts/reorder", async route => {
      if (outcome === "desired") await route.fetch();
      if (outcome === "other") {
        const response = await request.put(`${base}/accounts/reorder`, { data: { type: "expense", parent_id: f.root.id,
          ordered_accounts: [f.c, f.a, f.b].map(a => ({ id: a.id, version: a.version })) } });
        expect(response.ok()).toBeTruthy();
      }
      await route.fulfill({ status: 200, json: { malformed: true } });
    });
    await page.getByRole("button", { name: `${f.b.name} 순서 변경`, exact: true }).click();
    await page.getByRole("button", { name: `${f.b.name} 위로 이동`, exact: true }).click();
    await expect(page.locator(".order-status")).toContainText(outcome === "desired" ? "현재 순서를 확인" : outcome === "previous" ? "변경 전 순서" : "다른 변경");
    await expect(page.getByRole("button", { name: "실행취소", exact: true })).toHaveCount(0);
    await expect.poll(() => ids(page, [f.a.id, f.b.id, f.c.id])).toEqual(outcome === "desired" ? [f.b.id, f.a.id, f.c.id] : outcome === "previous" ? [f.a.id, f.b.id, f.c.id] : [f.c.id, f.a.id, f.b.id]);
  });
}

test("success avoids global refresh and same-message old timer cannot close latest undo", async ({ page, request }) => {
  const f = await fixture(request); await open(page); await page.clock.install();
  await expect(page.getByRole("button", { name: `${f.c.name} 순서 변경`, exact: true })).toBeEnabled();
  const reads: string[] = [];
  page.on("request", r => { if (r.method() === "GET" && /\/(accounts|balances|opening-balances|status)(\?|$)/.test(r.url())) reads.push(r.url()); });
  await page.getByRole("button", { name: `${f.c.name} 순서 변경`, exact: true }).click();
  await page.getByRole("button", { name: `${f.c.name} 위로 이동`, exact: true }).click();
  await expect(page.locator(".toast")).toContainText("순서 변경됨");
  await page.clock.runFor(4000);
  // The first success returned focus to the grip; its panel remains available.
  await page.getByRole("button", { name: `${f.c.name} 위로 이동`, exact: true }).click();
  await expect.poll(() => ids(page, [f.a.id, f.b.id, f.c.id])).toEqual([f.c.id, f.a.id, f.b.id]);
  await expect(page.locator(".toast")).toContainText("순서 변경됨");
  await page.clock.runFor(2500);
  await expect(page.getByRole("button", { name: "실행취소", exact: true })).toBeVisible();
  expect(reads).toEqual([]);
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect.poll(() => ids(page, [f.a.id, f.b.id, f.c.id])).toEqual([f.a.id, f.c.id, f.b.id]);
  expect(reads).toEqual([]);
});

test("dispatched write outlives route without late toast or reconciliation", async ({ page, request }) => {
  const f = await fixture(request); await open(page);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sent = new Promise<void>(resolve => { started = resolve; });
  let done!: () => void; const finished = new Promise<void>(resolve => { done = resolve; });
  await page.route("**/api/accounts/reorder", async route => { started(); await held; const result = await route.fetch(); await route.fulfill({ response: result }); done(); });
  await page.getByRole("button", { name: `${f.b.name} 순서 변경`, exact: true }).click();
  await page.getByRole("button", { name: `${f.b.name} 위로 이동`, exact: true }).click(); await sent;
  await expect(page.getByRole("button", { name: `${f.a.name} 순서 변경`, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "거래 내역", exact: true }).click();
  await expect(page.getByRole("heading", { name: "거래 내역" })).toBeVisible();
  release(); await finished;
  await expect(page.locator(".toast")).not.toContainText("순서 변경됨");
  await page.getByRole("button", { name: "계정·개시잔액", exact: true }).click();
  await expect.poll(() => ids(page, [f.a.id, f.b.id, f.c.id])).toEqual([f.b.id, f.a.id, f.c.id]);
});

test("keyboard fallback and stale undo preserve newer settings", async ({ page, request }) => {
  const f = await fixture(request); await open(page);
  const grip = page.getByRole("button", { name: `${f.b.name} 순서 변경`, exact: true });
  await grip.focus(); await page.keyboard.press("Enter");
  const up = page.getByRole("button", { name: `${f.b.name} 위로 이동`, exact: true });
  await expect(up).toBeFocused(); await page.keyboard.press("Escape"); await expect(grip).toBeFocused();
  await page.keyboard.press("Space"); await up.click(); await expect(page.locator(".toast")).toContainText("순서 변경됨");
  const snapshot = await (await request.get(`${base}/accounts`)).json();
  const current = snapshot.find((a: { id: number }) => a.id === f.b.id);
  const external = await request.put(`${base}/accounts/${f.b.id}/settings`, { data: {
    name: `${f.b.name}-changed`, parent_id: f.root.id, is_overdraft: false, version: current.version,
  } });
  expect(external.ok()).toBeTruthy();
  await page.getByRole("button", { name: "실행취소", exact: true }).click();
  await expect(page.locator(".order-status")).toContainText("실행 취소하지 못했습니다");
  await expect.poll(() => ids(page, [f.a.id, f.b.id, f.c.id])).toEqual([f.b.id, f.a.id, f.c.id]);
  await expect(page.getByRole("button", { name: `${f.b.name}-changed 순서 변경`, exact: true })).toBeVisible();
});
