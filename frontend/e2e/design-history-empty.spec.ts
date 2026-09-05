import { expect, test } from "./test";

test("빈 거래 내역에서 거래 입력으로 바로 이동할 수 있다", async ({ page }) => {
  await page.route("**/api/transactions", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return route.continue();
  });

  await page.goto("/");
  await page.locator(".side nav").getByRole("button", { name: "거래 내역", exact: true }).click();

  const emptyAction = page.getByRole("button", { name: "거래 입력", exact: true }).last();
  await expect(emptyAction).toBeVisible();
  await emptyAction.click();
  await expect(page.getByRole("heading", { name: "왼쪽 · 차변", exact: true })).toBeVisible();
});
