import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "./test";
import { editAccounts } from "./transactionEditFixtures";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

// Set the horizontal position *after* bringing the row into vertical view.
// Locator.tap() would auto-scroll the target and mask clipping at the extremes.
async function showAt(target: Locator, edge: "left" | "right" | "nearest") {
  await expect(target).toBeVisible();
  return target.evaluate((el, edge) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const scroll = el.closest<HTMLElement>(".accounts-ledger-wrap, .table-scroll")!;
    if (edge !== "nearest") scroll.scrollLeft = edge === "left" ? 0 : scroll.scrollWidth;
    return scroll.scrollLeft;
  }, edge);
}

async function hitPoints(target: Locator) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const { x, y, width, height } = box!;
  expect(width).toBeGreaterThanOrEqual(44);
  expect(height).toBeGreaterThanOrEqual(44);
  const center = { x: x + width / 2, y: y + height / 2 };
  const points = {
    center, left: { ...center, x: x + 2 }, right: { ...center, x: x + width - 2 },
    top: { ...center, y: y + 2 }, bottom: { ...center, y: y + height - 2 },
  };
  for (const [side, point] of Object.entries(points)) {
    expect(await target.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), point),
      `The ${side} of the target must receive pointer events`).toBe(true);
  }
  return points;
}

async function swipeRight(page: Page, start: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
  for (const dx of [12, 40, 75, 110]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + dx, y: start.y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

for (const width of [390, 1024]) {
  test(`chart checkbox has a native label target, one tab stop and row-local activation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/scenarios?status=active", r => r.fulfill({ json: [
      { id: 51, name: "봄", fork_date: "2026-11-01" }, { id: 52, name: "가을", fork_date: "2026-11-01" },
    ] }));
    await page.goto("/scenarios");
    await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
    const row = page.getByRole("row").filter({ hasText: "가을" });
    const box = row.getByRole("checkbox");
    const other = page.getByRole("checkbox", { name: "봄 차트에 표시" });
    const label = row.locator("label");
    const max = await showAt(label, "right");
    const points = await hitPoints(label);
    for (const [index, point] of Object.values(points).entries()) {
      await page.touchscreen.tap(point.x, point.y);
      await expect(box).toBeChecked({ checked: index % 2 === 0 });
      await expect(other).not.toBeChecked();
    }
    if (width === 390) {
      expect(max).toBeGreaterThan(0);
      await swipeRight(page, points.center);
      await expect.poll(() => page.locator(".table-scroll").evaluate(el => el.scrollLeft)).toBeLessThan(max);
      await expect(box).toBeChecked();
      await expect(other).not.toBeChecked();
    }
    await other.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "열기" }).first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(box).toBeFocused();
    expect(await box.evaluate(el => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none")).toBe(true);
    await page.keyboard.press("Space");
    await expect(box).not.toBeChecked();
    await page.keyboard.press("Tab");
    const open = row.getByRole("link");
    await expect(open).toBeFocused();
    await showAt(open, "right");
    const { right } = await hitPoints(open);
    await page.touchscreen.tap(right.x, right.y);
    await expect(page).toHaveURL(/\/scenarios\/52$/);
  });
}

test("account draft, overdraft radio and opening actions respond inside their own row", async ({ page }) => {
  const assets = [1, 2].map(id => ({ ...editAccounts[1], id: 700 + id, name: `은행${id}`, is_overdraft: true }));
  await page.route("**/api/accounts", r => r.fulfill({ json: assets }));
  await page.route("**/api/opening-balances", r => r.fulfill({ json: [] }));
  await page.goto("/accounts");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  const account = page.getByRole("link", { name: "은행2", exact: true });
  expect(await showAt(account, "left")).toBe(0);
  const { left } = await hitPoints(account);
  await page.touchscreen.tap(left.x, left.y);
  await expect(page).toHaveURL(/account_id=702/);
  await page.goBack();

  const add = page.getByRole("row").filter({ hasText: "자산" }).getByRole("button", { name: "새 분류" });
  expect(await showAt(add, "right")).toBeGreaterThan(0);
  const addPoints = await hitPoints(add);
  await page.touchscreen.tap(addPoints.center.x, addPoints.center.y);
  const draft = page.locator("tr.account-inline");
  const label = draft.locator(".overdraft-check");
  await showAt(label, "nearest");
  const draftPoints = await hitPoints(label);
  await page.touchscreen.tap(draftPoints.right.x, draftPoints.right.y);
  await expect(draft.getByRole("checkbox")).toBeChecked();
  const cancel = draft.getByRole("button", { name: "취소" });
  expect(await showAt(cancel, "right")).toBeGreaterThan(0);
  const cancelPoints = await hitPoints(cancel);
  await page.touchscreen.tap(cancelPoints.center.x, cancelPoints.center.y);
  await expect(draft).toHaveCount(0);

  const row = page.locator('tr[data-order-row="702"]');
  const neighbor = page.locator('tr[data-order-row="701"]');
  const minus = row.locator(".opening-state label").filter({ hasText: "마이너스 사용" });
  await showAt(minus, "nearest");
  const radioPoints = await hitPoints(minus);
  await page.touchscreen.tap(radioPoints.bottom.x, radioPoints.bottom.y);
  await expect(row.getByRole("radio", { name: "마이너스 사용" })).toBeChecked();
  await expect(neighbor.getByRole("radio", { name: "마이너스 사용" })).not.toBeChecked();
  const zero = row.getByRole("button", { name: "0원으로 확인" });
  await showAt(zero, "right");
  const zeroPoints = await hitPoints(zero);
  await page.touchscreen.tap(zeroPoints.top.x, zeroPoints.top.y);
  await expect(row.getByRole("button", { name: "해제" })).toBeVisible();
  await expect(neighbor.getByRole("button", { name: "0원으로 확인" })).toBeVisible();
});

test("touching a history memo at the left and edit at the right acts on the same transaction", async ({ page }) => {
  const items = [81, 82].map(id => ({
    id, date: "2026-11-01", description: `거래${id}`, memo: `메모${id}`, tags: [],
    postings: [{ account_id: 101, amount: { amount: 100, currency: "KRW" } },
      { account_id: 102, amount: { amount: -100, currency: "KRW" } }],
  }));
  await page.route("**/api/accounts", r => r.fulfill({ json: editAccounts }));
  await page.route("**/api/transaction-history?*", r => r.fulfill({ json: { items, total: 2, page: 1, total_pages: 1, page_size: 100 } }));
  await page.goto("/transactions?start=2026-11-01&end=2026-11-30");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  const row = page.getByRole("row").filter({ hasText: "거래82" });
  const memo = row.locator("summary");
  expect(await showAt(memo, "left")).toBe(0);
  const { bottom } = await hitPoints(memo);
  await page.touchscreen.tap(bottom.x, bottom.y);
  await expect(row.getByText("메모82", { exact: true })).toBeVisible();
  await expect(page.getByText("메모81", { exact: true })).toBeHidden();
  const edit = row.getByRole("button", { name: "수정" });
  expect(await showAt(edit, "right")).toBeGreaterThan(0);
  await hitPoints(row.getByRole("button", { name: "삭제" }));
  const { right } = await hitPoints(edit);
  await page.touchscreen.tap(right.x, right.y);
  await expect(page).toHaveURL(/\/transactions\/82\/edit$/);
});
