import { expect, test, type Page } from "./test";
import { editAccounts, makeDetail } from "./transactionEditFixtures";

const search = "start=2026-01-01&end=2026-12-31&page=";
const rows = (page: Page) => page.locator(".history-scroll tbody tr");

async function history(page: Page, count = 1, pageNumber = 1) {
  const list = Array.from({ length: count }, (_, i) => {
    const detail = makeDetail({ id: 71 + i, description: `거래 ${71 + i}` });
    return { ...detail, postings: detail.postings.map(p => ({ account_id: p.account_id,
      amount: { amount: p.amount, currency: p.currency } })) };
  }).reverse();
  await page.route("**/api/accounts", r => r.fulfill({ json: editAccounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: ["데이트"] }));
  await page.route("**/api/transaction-history?*", r => {
    const current = Number(new URL(r.request().url()).searchParams.get("page"));
    return r.fulfill({ json: { items: list.slice((current - 1) * 100, current * 100),
      total: count, page: current, total_pages: Math.ceil(count / 100), page_size: 100 } });
  });
  await page.goto(`/transactions?${search}${pageNumber}`);
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await expect(rows(page)).toHaveCount(Math.min(100, count - (pageNumber - 1) * 100));
}

for (const receipt of [null, { deleted: 999 }]) {
  test(`invalid delete receipt ${JSON.stringify(receipt)} keeps uncertainty and prevents replay`, async ({ page }) => {
    await history(page);
    let deletes = 0;
    await page.route("**/api/transactions/71", r => {
      deletes++;
      return r.fulfill({ contentType: "application/json", body: JSON.stringify(receipt) });
    });
    page.on("dialog", d => d.accept());
    const remove = rows(page).getByRole("button", { name: "삭제", exact: true });
    await remove.click();
    await expect(page.getByRole("alert")).toContainText("삭제 결과를 확인할 수 없습니다");
    await expect(remove).toBeDisabled();
    await page.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(remove).toBeDisabled();
    await expect(page.getByText("거래를 삭제했습니다.", { exact: true })).toHaveCount(0);
    expect(deletes).toBe(1);
  });
}

for (const busy of [false, true]) {
  test(`delete ${busy ? "database_busy is a retryable refusal" : "HTTP 500 remains uncertain"}`, async ({ page }) => {
    await history(page);
    let deletes = 0;
    await page.route("**/api/transactions/71", r => {
      deletes++;
      return r.fulfill({ status: busy ? 503 : 500,
        json: { detail: { code: busy ? "database_busy" : "internal_error", message: "서버 오류" } } });
    });
    page.on("dialog", d => d.accept());
    const remove = rows(page).getByRole("button", { name: "삭제", exact: true });
    await remove.click();
    await expect(rows(page)).toHaveCount(1);
    if (busy) {
      await expect(page.getByText("삭제하지 못했습니다. 서버 오류", { exact: true })).toBeVisible();
      await expect(remove).toBeEnabled();
      await expect(page.getByText("삭제 결과를 확인할 수 없습니다. 목록을 다시 조회해 주세요.")).toHaveCount(0);
    } else {
      await expect(page.getByRole("alert")).toContainText("삭제 결과를 확인할 수 없습니다");
      await expect(remove).toBeDisabled();
    }
    expect(deletes).toBe(1);
  });
}

test("Previous replaces page two with the first page and focuses results", async ({ page }) => {
  await history(page, 201, 2);
  await expect(rows(page).first()).toContainText("거래 171");
  await page.getByRole("button", { name: "이전", exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("page") === "1"
    && url.searchParams.get("start") === "2026-01-01" && url.searchParams.get("end") === "2026-12-31");
  await expect(rows(page)).toHaveCount(100);
  await expect(rows(page).first()).toContainText("거래 271");
  await expect(rows(page).last()).toContainText("거래 172");
  await expect(page.getByRole("navigation", { name: "거래 페이지" })).toContainText("1–100 / 201건");
  await expect(page.getByRole("button", { name: "이전", exact: true })).toBeDisabled();
  await expect(page.locator("#history-result-title")).toBeFocused();
});

test("mobile edit cancellation restores nonzero table horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await history(page);
  await page.route("**/api/transactions/71", r => r.fulfill({ json: makeDetail() }));
  const edit = page.locator("#edit-transaction-71"), table = page.locator(".history-scroll");
  await edit.scrollIntoViewIfNeeded();
  const offset = await table.evaluate(e => e.scrollLeft);
  expect(offset).toBeGreaterThan(0);
  await edit.click();
  await expect(page.getByRole("heading", { name: "거래 수정", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "취소하고 거래 내역으로", exact: true }).click();
  await expect(edit).toBeFocused();
  await expect.poll(() => table.evaluate(e => e.scrollLeft)).toBe(offset);
  await expect(page).toHaveURL(url => url.searchParams.get("page") === "1" && url.searchParams.get("end") === "2026-12-31");
});
