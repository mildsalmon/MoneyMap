import { expect, test, type Route } from "./test";
import { editAccounts, makeDetail } from "./transactionEditFixtures";

// Regression: repeated edit returns must prefer the latest list visit snapshot.
// Found by gstack review on 2026-10-04.
test("second native Back preserves the latest unapplied draft and focus", async ({ page }) => {
  const detail = makeDetail();
  await page.route("**/api/accounts", r => r.fulfill({ json: editAccounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: ["데이트", "여행"] }));
  await page.route("**/api/transactions/71", r => r.fulfill({ json: detail }));
  await page.route("**/api/transaction-history?*", r => r.fulfill({ json: {
    items: [{ ...detail, postings: detail.postings.map(p => ({ account_id: p.account_id,
      amount: { amount: p.amount, currency: p.currency } })) }],
    total: 1, page: 1, page_size: 100, total_pages: 1,
  } }));
  await page.goto("/transactions?start=2026-01-01&end=2026-12-31&page=1");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  const edit = page.locator("#edit-transaction-71");
  await edit.click();
  await page.getByRole("button", { name: "취소하고 거래 내역으로", exact: true }).click();
  await expect(edit).toBeFocused();
  await page.getByLabel("종료일", { exact: true }).fill("2026-11-30");
  await page.getByLabel("태그", { exact: true }).selectOption("여행");
  await edit.click();
  await expect(page.getByRole("heading", { name: "거래 수정", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("종료일", { exact: true })).toHaveValue("2026-11-30");
  await expect(page.getByLabel("태그", { exact: true })).toHaveValue("여행");
  await expect(edit).toBeFocused();
  await expect(page.getByText(/조회 버튼을 눌러 적용하세요/)).toBeVisible();
  await expect(page).toHaveURL(url => url.searchParams.get("end") === "2026-12-31" && !url.searchParams.has("tag"));
});

test("pending and uncertain deletion survive leaving and returning to history", async ({ page }) => {
  const detail = makeDetail();
  await page.route("**/api/accounts", r => r.fulfill({ json: editAccounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: [] }));
  await page.route("**/api/transaction-history?*", r => r.fulfill({ json: {
    items: [{ ...detail, postings: detail.postings.map(p => ({ account_id: p.account_id,
      amount: { amount: p.amount, currency: p.currency } })) }],
    total: 1, page: 1, page_size: 100, total_pages: 1,
  } }));
  let held: Route | undefined, deletes = 0;
  await page.route("**/api/transactions/71", r => { held = r; deletes++; });
  await page.goto("/transactions?start=2026-01-01&end=2026-12-31&page=1");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  const remove = page.locator(".history-actions").getByRole("button", { name: "삭제", exact: true });
  page.on("dialog", d => d.accept());
  await remove.click();
  await expect.poll(() => deletes).toBe(1);
  const nav = page.locator(".side nav");
  await nav.getByRole("button", { name: "거래 입력", exact: true }).click();
  await nav.getByRole("button", { name: "거래 내역", exact: true }).click();
  await expect(remove).toBeDisabled();
  await nav.getByRole("button", { name: "거래 입력", exact: true }).click();
  await held!.abort("failed");
  await nav.getByRole("button", { name: "거래 내역", exact: true }).click();
  await expect(page.getByText("삭제 결과를 확인할 수 없습니다. 목록을 다시 조회해 주세요.")).toBeVisible();
  await expect(remove).toBeDisabled();
  await page.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(remove).toBeDisabled();
  expect(deletes).toBe(1);
});
