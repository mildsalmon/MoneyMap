import { expect, test } from "./test";
import { withLedger } from "./withLedger";

test.use({timezoneId: "Asia/Seoul"});

for (const mode of ["mixed", "won"] as const) {
  test(`migrated ${mode} ledger shows KRW cards, table and chart tooltip`, async ({page}, info) => {
    await withLedger(page, info.outputPath("fixture.db"), mode, async () => {
      await page.goto("/");
      await expect(page.getByText(/원화\(KRW\) 기준/)).toBeVisible();
      await expect(page.locator(".strip .hero")).toHaveText("₩750");
      await expect(page.locator(".strip .v")).toHaveText(["₩1,000", "₩250", "₩750"]);
      await expect(page.getByRole("table", {name:"자산 잔액",exact:true})).toContainText("750");
      await expect(page.locator(".dashboard-expenses tbody tr")).toHaveText("Expense250");
      await page.getByRole("button", {name:"표로 보기",exact:true}).click();
      const rows = page.locator(".dashboard-projection table tbody tr");
      await expect(rows.first().locator("td").nth(1)).toHaveText("₩750");
      await expect(rows.last().locator("td").last()).toHaveText("₩830");
      const chart = page.locator(".chart-wrap");
      await chart.press("ArrowRight");
      await expect(page.locator(".chart-tip .val")).toHaveText(["₩750", "₩750"]);
      await chart.press("Escape"); await chart.press("ArrowLeft");
      await expect(page.locator(".chart-tip .val")).toHaveText("₩830");
    });
  });
}

test("two safe deposits retain their exact total across the dashboard", async ({page, request}, info) => {
  await withLedger(page, info.outputPath("fixture.db"), "empty", async api => {
    const create = async (type: string) => {
      const response = await request.post(`${api}/accounts`, {data:{name:type, type}});
      expect(response.status()).toBe(201); return (await response.json()).id;
    };
    const bank = await create("asset"), income = await create("income");
    const date = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Seoul"}).format(new Date());
    for (const amount of [2, Number.MAX_SAFE_INTEGER]) {
      const result = await request.post(`${api}/transactions`, {data:{date, postings:[
        {account_id:bank, amount}, {account_id:income, amount:-amount},
      ]}});
      expect(result.status()).toBe(201);
    }
    await page.goto("/");
    const total = "₩9,007,199,254,740,993";
    await expect(page.locator(".strip .hero")).toHaveText(total);
    await expect(page.locator(".strip .v")).toHaveText([total, "₩0", total]);
    await expect(page.locator(".dashboard-balances .sum")).toContainText(total);
    await expect(page.getByText("실제: 금액이 차트의 정확한 원 단위 표시 범위를 넘었습니다.")).toBeVisible();
    await expect(page.locator(".chart-wrap")).toHaveCount(0);
  });
});
