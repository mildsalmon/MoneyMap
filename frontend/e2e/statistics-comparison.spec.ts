import { test, expect } from "./test";

const base = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;

test("부분 월 원화 비교에서 복수 태그·분류 순액과 원본 환불 분개를 대조한다", async ({ request, page }, info) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  async function create(path: string, data: object) {
    const r = await request.post(base + path, { data });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).id as number;
  }
  const bank = await create("/accounts", { type: "asset", name: `통장 ${suffix}` });
  const expense = await create("/accounts", { type: "expense", name: `비용 ${suffix}` });
  const living = await create("/living-categories", { name: `생활비 ${suffix}` });
  const invest = await create("/living-categories", { name: `투자 ${suffix}` });
  const ids: number[] = [];
  const tagA = `출장${suffix}`, tagB = `카드${suffix}`;
  async function transaction(date: string, description: string, tags: string[], legs: {amount: number; category_id?: number}[]) {
    ids.push(await create("/transactions", { date, description, tags, postings: [
      { account_id: bank, amount: -legs.reduce((n, leg) => n + leg.amount, 0) },
      ...legs.map(leg => ({ account_id: expense, ...leg }))] }));
  }
  const table = page.getByRole("table", { name: "태그별 기간 비교" });
  const row = (name: string) => table.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) })
    .filter({ has: page.getByRole("cell", { name: "지출", exact: true }) });
  try {
    await transaction("2005-02-10", "전기 지출", [tagA], [{ amount: 5000, category_id: living }]);
    await transaction("2005-02-11", "비교 기간 밖", [tagA], [{ amount: 90000 }]);
    await transaction("2005-03-08", "분할 영수증", [tagA, tagB], [{ amount: 8000, category_id: living }, { amount: 4000, category_id: invest }]);
    await page.clock.install({ time: new Date("2005-03-10T01:00:00Z") });
    await page.goto("/statistics");
    await page.getByRole("button", { name: "이번 달", exact: true }).click();
    await expect(page.getByText(/전기 2005-02-01 ~ 2005-02-10 \(10일\)/)).toBeVisible();
    await expect(row("전체").getByRole("cell")).toHaveText(["지출", "₩12,000", "₩5,000", "₩7,000", "140%"]);
    await expect(row(tagA)).toContainText("₩12,000");
    await expect(row(tagB).getByRole("cell")).toHaveText(["지출", "₩12,000", "₩0", "₩12,000", "산출 불가"]);
    await transaction("2005-03-10", "부분 환불", [tagB], [{ amount: -2000, category_id: living }]);
    await transaction("2005-03-10", "기타 비용", [], [{ amount: 700 }]);
    await page.reload();
    await expect(row("전체")).toContainText("₩10,700");
    await expect(row(tagA)).toContainText("₩12,000");
    await expect(row(tagB)).toContainText("₩10,000");
    const categories = page.getByRole("table", { name: "생활 분류별 수입과 지출" });
    for (const [name, amount] of [[`생활비 ${suffix}`, "₩6,000"], [`투자 ${suffix}`, "₩4,000"], ["미분류", "₩700"]]) {
      await expect(categories.getByRole("row").filter({ hasText: name })).toContainText(amount);
    }
    await page.getByLabel("비교할 생활 분류").selectOption(String(living));
    await page.getByLabel("비교할 태그").selectOption({ label: tagB });
    await expect(row(tagB)).toContainText("₩6,000");
    const applied = page.url();
    await row(tagB).getByRole("link", { name: /조회 기간 거래/ }).click();
    const details = page.getByRole("table", { name: "비교에 포함된 거래" });
    await expect(details.getByRole("row").filter({ hasText: "분할 영수증" })).toContainText("₩8,000");
    await expect(details.getByRole("row").filter({ hasText: "부분 환불" })).toContainText("−₩2,000");
    await details.getByRole("button", { name: "부분 환불" }).click();
    await expect(page.getByRole("table", { name: "원본 거래 분개" })).toContainText("−₩2,000");
    await page.screenshot({ path: info.outputPath("filtered-refund.png") });
    await page.getByRole("link", { name: "비교 통계로 돌아가기" }).click();
    await expect(page).toHaveURL(applied);
    await expect(row(tagB)).toContainText("₩6,000");
    await page.getByRole("button", { name: "조회", exact: true }).click();
    await expect(page.getByText(/전기 2005-02-19 ~ 2005-02-28 \(10일\)/)).toBeVisible();
  } finally {
    for (const id of ids) await request.delete(`${base}/transactions/${id}`);
  }
});
