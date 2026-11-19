import { blockExternalStyles, expect, test, type APIRequestContext } from "./test";

const base = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
const close = "2025-03-31";

const syntheticAccounts = new Set<number>();

test.afterEach(async ({ request }) => {
  const response = await request.get(base + "/transactions");
  expect(response.ok()).toBe(true);
  const transactions: { id: number; postings: { account_id: number }[] }[] = await response.json();
  for (const txn of transactions) {
    if (txn.postings.some(posting => syntheticAccounts.has(posting.account_id))) {
      expect((await request.delete(base + "/transactions/" + txn.id)).ok()).toBe(true);
    }
  }
  syntheticAccounts.clear();
});

async function account(request: APIRequestContext, type: string) {
  const result = await request.post(base + "/accounts", { data: { name: `대사-${type}-${crypto.randomUUID()}`, type } });
  expect(result.status()).toBe(201);
  const created: { id: number; name: string } = await result.json();
  syntheticAccounts.add(created.id);
  return created;
}

async function post(request: APIRequestContext, id: number, other: number, amount: number, date = close) {
  const result = await request.post(base + "/transactions", { data: { date, description: "대사 검산",
    postings: [{ account_id: id, amount }, { account_id: other, amount: -amount }] } });
  expect(result.status()).toBe(201);
}

for (const type of ["asset", "liability"]) {
  test(`${type} 명세서 미리보기, 취소, 재계산과 유실 응답 재시도`, async ({ page, request }) => {
    const target = await account(request, type);
    const other = await account(request, "equity");
    const sign = type === "asset" ? 1 : -1;
    await post(request, target.id, other.id, sign * 95000);
    await post(request, target.id, other.id, sign * 500, "2025-04-01");
    await page.goto("/accounts");
    await page.getByRole("link", { name: "잔액 대사" }).click();
    const calculate = page.getByRole("button", { name: /잔액 (비교|다시 계산)/ });
    await page.getByLabel("대사 계정").selectOption(String(target.id));
    await page.getByLabel("마감일", { exact: true }).fill(close);
    await page.getByLabel(/명세서 (미상환액|잔액)/).fill("100000");
    await calculate.click();
    await expect(page.getByText("₩95,000", { exact: true })).toBeVisible();
    await expect(page.getByText("+₩5,000", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "취소" }).click();
    await expect(page.getByRole("heading", { name: "마감 잔액 비교" })).toHaveCount(0);
    await calculate.click();
    const adjustments = async () => {
      const result = await request.get(base + "/transactions");
      return (await result.json() as { memo: string; description: string; postings: { account_id: number; amount: { amount: number } }[] }[])
        .filter(t => t.description === "잔액 대사 조정" && t.postings.some(p => p.account_id === target.id));
    };
    const prepare = async () => {
      await page.getByLabel("상대 계정").selectOption(String(other.id));
      await page.getByLabel("조정 사유").fill("월말 누락분");
    };
    await prepare();
    expect(await adjustments()).toHaveLength(0);
    await post(request, target.id, other.id, sign * 1000, "2025-03-30");
    const confirm = page.getByRole("button", { name: "조정 거래 확정" });
    await confirm.click();
    await expect(page.getByRole("alert")).toContainText("다시 계산");
    expect(await adjustments()).toHaveLength(0);
    await calculate.click();
    await expect(page.getByText("+₩4,000", { exact: true })).toBeVisible();
    await prepare();
    await test.info().attach("마감 잔액과 조정 분개", { body: await page.locator(".reconciliation").screenshot(), contentType: "image/png" });
    const attempts: string[] = [];
    await page.route("**/api/reconciliation/confirm", async route => {
      attempts.push(route.request().postData()!);
      if (attempts.length > 1) return route.continue();
      expect((await route.fetch()).ok()).toBe(true);
      if (type === "liability") return route.fulfill({ json: {} });
      await route.abort("failed");
    });
    await confirm.click();
    await expect(page.getByRole("button", { name: "같은 요청으로 다시 확인" })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "같은 요청으로 다시 확인" }).click();
    await expect(page.getByRole("status")).toContainText("확정 시점 차이 ₩0");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    await calculate.click();
    await expect(page.getByRole("status")).toHaveText("잔액이 일치합니다.");
    const saved = await adjustments();
    expect(saved).toHaveLength(1);
    expect(saved[0].memo).toBe("월말 누락분");
    expect(saved[0].postings.map(p => [p.account_id, p.amount.amount])).toEqual([
      [target.id, sign * 4000], [other.id, -sign * 4000],
    ]);
  });
}

test("외화 명세서의 소수 단위와 마감일 거래 내역 링크", async ({ page, request }) => {
  const target = await account(request, "asset");
  const other = await account(request, "income");
  await post(request, target.id, other.id, 95000);
  let materializations = 0;
  page.on("request", request => { if (request.url().endsWith("/api/materialize")) materializations++; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/accounts/reconciliation");
  await page.getByLabel("대사 계정").selectOption(String(target.id));
  await page.getByLabel("마감일", { exact: true }).fill(close);
  await page.getByRole("combobox", { name: "통화", exact: true }).selectOption("USD");
  await page.getByLabel("명세서 잔액").fill("10.255");
  await page.getByRole("button", { name: "잔액 비교" }).click();
  await expect(page.getByRole("alert")).toContainText("2자리");
  await page.getByLabel("명세서 잔액").fill("10.25");
  await page.getByRole("button", { name: "잔액 비교" }).click();
  await expect(page.getByText("+US$10.25", { exact: true }).or(page.getByText("+$10.25", { exact: true }))).toBeVisible();
  const history = page.getByRole("link", { name: /마감일까지 거래 내역/ });
  await blockExternalStyles(page.context());
  const opened = page.waitForEvent("popup");
  await history.click();
  const popup = await opened;
  await expect(popup.getByRole("row").filter({ hasText: "대사 검산" })).toHaveCount(1);
  await popup.close();
  await page.getByLabel("상대 계정").selectOption(String(other.id));
  await page.getByLabel("조정 사유").fill("외화 입금 누락");
  await page.getByRole("button", { name: "조정 거래 확정" }).click();
  await page.getByRole("button", { name: "잔액 다시 계산" }).click();
  await expect(page.getByRole("status")).toHaveText("잔액이 일치합니다.");
  const krw = await request.post(base + "/reconciliation/preview", { data: {
    account_id: target.id, currency: "KRW", closing_date: close, statement_minor: "95000",
  } });
  expect((await krw.json()).difference_minor).toBe("0");
  expect(materializations).toBe(0);
});
