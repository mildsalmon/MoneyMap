import { expect, test, type Page, type Request, type Route } from "./test";

async function waitForStartup(page: Page) {
  const materialized = page.waitForResponse(response => response.url().endsWith("/api/materialize") && response.ok());
  const statusLoaded = page.waitForResponse(response => response.url().endsWith("/api/status") && response.ok());
  await page.goto("/scenarios");
  await Promise.all([materialized, statusLoaded]);
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  await expect(page.getByText("목록을 불러오는 중…", { exact: true })).toBeHidden();
}

const screens = [
  { nav: "대시보드", path: "/", loading: "장부 정보 확인 중…", error: "장부 정보를 불러오지 못했습니다.", retry: "다시 불러오기" },
  { nav: "거래 내역", path: "/transactions", loading: "거래 내역 확인 중…", error: "거래 내역을 불러오지 못했습니다.", retry: "다시 불러오기" },
  { nav: "반복 규칙", path: "/rules", loading: "반복 규칙 확인 중…", error: "반복 규칙을 불러오지 못했습니다.", retry: "다시 불러오기" },
  { nav: "계정·개시잔액", path: "/accounts", loading: "계정 확인 중…", error: "계정을 불러오지 못했습니다.", retry: "다시 시도" },
  { nav: "거래 입력", path: "/transactions/new", loading: "계정 확인 중…", error: "계정을 불러오지 못했습니다.", retry: "계정 다시 불러오기" },
];

for (const screen of screens) {
  test(`${screen.nav}: 화면 이탈 시 조회를 취소하고 재진입하면 다시 불러온다`, async ({ page }) => {
    await waitForStartup(page);
    const held: Route[] = [];
    const failed = new Set<Request>();
    page.on("requestfailed", request => { failed.add(request); });
    await page.route("**/api/accounts", route => { held.push(route); });
    await page.locator(".side nav").getByRole("button", { name: screen.nav, exact: true }).click();
    await expect(page.getByText(screen.loading, { exact: true })).toBeVisible();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.locator(".side nav").getByRole("button", { name: "시나리오", exact: true }).click();
    await expect.poll(() => held.every(route => failed.has(route.request()))).toBe(true);
    await page.unroute("**/api/accounts");
    for (const route of held) {
      try { await route.fulfill({ json: [] }); } catch { /* cancelled fetch no longer consumes this response */ }
    }
    const loaded = page.waitForResponse(response => response.url().endsWith("/api/accounts") && response.ok());
    await page.locator(".side nav").getByRole("button", { name: screen.nav, exact: true }).click();
    await loaded;
    await expect(page.getByText(screen.loading, { exact: true })).toBeHidden();
    await expect(page.getByText(screen.error, { exact: false })).toBeHidden();
  });

  test(`${screen.nav}: 조회 실패를 빈 결과로 표시하지 않고 재시도한다`, async ({ page }) => {
    await waitForStartup(page);
    await page.route("**/api/accounts", route => route.fulfill({ status: 503, json: { detail: "조회 재시도 확인" } }));
    await page.locator(".side nav").getByRole("button", { name: screen.nav, exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: screen.error });
    await expect(alert).toContainText("조회 재시도 확인");
    await expect(page.getByText(screen.loading, { exact: true })).toBeHidden();
    if (screen.path === "/transactions") await expect(page.getByText("아직 거래가 없습니다.", { exact: true })).toBeHidden();
    if (screen.path === "/rules") await expect(page.getByText("규칙이 없습니다.", { exact: true })).toBeHidden();
    if (screen.path === "/transactions/new") await page.getByLabel("금액", { exact: true }).fill("9876");
    await page.unroute("**/api/accounts");
    await alert.getByRole("button", { name: screen.retry, exact: true }).click();
    await expect(alert).toBeHidden();
    await expect(page.getByText(screen.loading, { exact: true })).toBeHidden();
    if (screen.path === "/transactions/new") await expect(page.getByLabel("금액", { exact: true })).toHaveValue("9,876");
  });
}
