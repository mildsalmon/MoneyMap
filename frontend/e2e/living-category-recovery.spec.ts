import { blockExternalStyles, expect, test, type APIRequestContext } from "./test";

const api = process.env.MONEYMAP_E2E_API_BASE
  ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
const date = "2022-03-05";

async function create(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(`${api}/${path}`, { data });
  expect(response.status()).toBe(201);
  return response.json();
}

async function receipt(request: APIRequestContext, split: boolean, categoryId?: number) {
  const unique = crypto.randomUUID();
  const cost = await create(request, "accounts", { name: `비용 ${unique}`, type: "expense" });
  const bank = await create(request, "accounts", { name: `통장 ${unique}`, type: "asset" });
  return create(request, "transactions", {
    date, description: unique, postings: [
      { account_id: cost.id, amount: 8000, category_id: categoryId },
      ...(split ? [{ account_id: cost.id, amount: 4000 }] : []),
      { account_id: bank.id, amount: split ? -12000 : -8000 },
    ],
  });
}

for (const split of [false, true]) {
  test(`real two-window 409 preserves each ${split ? "split" : "basic"} category in the previous draft`, async ({ page, context, request }) => {
    const mine = await create(request, "living-categories", { name: `내 선택 ${Date.now()}` });
    const other = await create(request, "living-categories", { name: `다른 선택 ${Date.now()}` });
    const txn = await receipt(request, split);
    const url = `${api}/transactions/${txn.id}`;
    const second = await context.newPage();
    await blockExternalStyles(second);
    try {
      const label = split ? "1행 생활 분류" : "차변 생활 분류";
      for (const tab of [page, second]) {
        await tab.goto(`/transactions/${txn.id}/edit`);
        await expect(tab.getByLabel(label)).toBeEnabled();
      }
      await page.getByLabel(label).selectOption(String(mine.id));
      if (split) await page.getByLabel("2행 생활 분류").selectOption(String(other.id));
      await second.getByLabel(label).selectOption(String(other.id));
      await second.getByRole("button", { name: "변경사항 저장" }).click();
      await expect(second).toHaveURL(/\/transactions\?/);
      const winner = await (await request.get(url)).json();

      let writes = 0;
      page.on("request", r => { if (r.url() === url && r.method() === "PUT") writes++; });
      const conflict = page.waitForResponse(r => r.url() === url && r.request().method() === "PUT");
      await page.getByRole("button", { name: "변경사항 저장" }).click();
      expect((await conflict).status()).toBe(409);
      await page.getByRole("button", { name: "최신 거래 확인" }).click();
      await page.getByRole("button", { name: "최신 값으로 다시 수정" }).click();
      await expect(page.getByLabel(label)).toHaveValue(String(other.id));
      if (split) await expect(page.getByLabel("2행 생활 분류")).toHaveValue("");
      await page.getByText("저장하지 못한 작성 내용", { exact: true }).click();
      const summary = page.locator(".edit-draft-summary");
      await expect(summary.getByRole("listitem").nth(0)).toContainText(`${mine.name} (#${mine.id})`);
      if (split) await expect(summary.getByRole("listitem").nth(1)).toContainText(`${other.name} (#${other.id})`);
      expect(await (await request.get(url)).json()).toEqual(winner);
      expect(writes).toBe(1);
    } finally {
      await second.close();
      await request.delete(url);
    }
  });
}

test("full 50-character category and both amount columns fit mobile and desktop statistics", async ({ page, request }) => {
  const name = "W".repeat(50);
  const existing = await (await request.get(`${api}/living-categories`)).json();
  const category = existing.find((row: { name: string }) => row.name === name)
    ?? await create(request, "living-categories", { name });
  const txn = await receipt(request, false, category.id);
  try {
    await page.goto(`/statistics?start=${date}&end=${date}`);
    const table = page.getByRole("table", { name: "생활 분류별 수입과 지출" });
    const row = table.getByRole("row").filter({ hasText: name });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(row.getByRole("rowheader")).toHaveText(name);
      await expect(row.getByRole("cell")).toHaveText(["₩0", "₩8,000"]);
      const layout = await row.evaluate(element => {
        const main = element.closest("main")!;
        const cells = (element as HTMLTableRowElement).cells;
        const range = document.createRange();
        range.selectNodeContents(cells[0]);
        return { client: main.clientWidth, scroll: main.scrollWidth, lines: range.getClientRects().length,
          cellsInside: [...cells].every(cell => cell.getBoundingClientRect().right <= main.getBoundingClientRect().right) };
      });
      expect(layout.scroll).toBeLessThanOrEqual(layout.client);
      expect(layout.cellsInside).toBe(true);
      if (width === 390) expect(layout.lines).toBeGreaterThan(1);
      else expect(layout.lines).toBe(1);
    }
  } finally { await request.delete(`${api}/transactions/${txn.id}`); }
});
