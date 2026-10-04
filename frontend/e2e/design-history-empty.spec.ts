import { expect, test } from "./test";

test("빈 기간 조회에서 조건을 변경할 수 있고 자동으로 거래 입력이나 전체 조회로 바뀌지 않는다", async ({ page }) => {
  await page.route("**/api/transaction-history?*", route => route.fulfill({ json: { items: [], total: 0, page: 1, total_pages: 1, page_size: 100 } }));
  await page.goto("/transactions");
  await expect(page.getByText("선택한 기간과 태그에 해당하는 거래가 없습니다.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "0건", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "거래 페이지" })).toHaveCount(0);
  await page.getByRole("button", { name: "조회 조건 변경", exact: true }).click();
  await expect(page.getByLabel("시작일", { exact: true })).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/transactions");
});
