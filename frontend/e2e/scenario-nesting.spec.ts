import { expect, test, type Page } from "./test";

const api = process.env.MONEYMAP_E2E_API_BASE
  ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;

// An early year keeps the shared suite's other projections outside this example.
const may = (day: number) => `1999-05-${String(day).padStart(2, "0")}`;

async function branch(page: Page, name: string, day: number, parent?: string) {
  await page.goto("/scenarios");
  await page.getByLabel("이름", { exact: true }).fill(name);
  if (parent) await page.getByLabel("기준 장부").selectOption({ label: parent });
  await page.getByLabel("시작 기준일").fill(may(day));
  await page.getByRole("button", { name: "+ 새 시나리오" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}

async function planned(page: Page, bank: number, expense: number, label: string, day: number, amount: number) {
  await page.getByLabel("예정 거래 내역", { exact: true }).fill(label);
  await page.getByLabel("예정 거래 날짜").fill(may(day));
  await page.getByLabel("분개 1 계정", { exact: true }).selectOption(String(bank));
  await page.getByLabel("분개 2 계정", { exact: true }).selectOption(String(expense));
  await page.getByLabel("분개 1 금액 (부호 포함)").fill(String(-amount));
  await page.getByLabel("분개 2 금액 (부호 포함)").fill(String(amount));
  await page.getByRole("button", { name: "예정 거래 저장" }).click();
  await expect(page.getByRole("table", { name: "시나리오 예정 거래" })).toContainText(label);
}

const ledgerTest = test.extend<{ ledger: { bank: number; expense: number } }>({
  ledger: async ({ request }, use) => {
    const accounts: number[] = [];
    for (const [name, type] of [["통장", "asset"], ["비용", "expense"], ["수입", "income"]]) {
      const response = await request.post(`${api}/accounts`, { data: { name: `중첩 검산 ${name}`, type } });
      expect(response.ok()).toBeTruthy();
      accounts.push((await response.json()).id);
    }
    const [bank, expense, income] = accounts;
    const transactionIds: number[] = [];
    try {
      for (const [day, amount] of [[1, 1000], [8, 700]]) {
        const response = await request.post(`${api}/transactions`, { data: {
          date: may(day), description: "실제 수입",
          postings: [{ account_id: bank, amount }, { account_id: income, amount: -amount }],
        } });
        expect(response.ok()).toBeTruthy();
        transactionIds.push((await response.json()).id);
      }
      const actual = await (await request.get(`${api}/balances?at=${may(11)}`)).json();
      expect(actual.accounts.find((a: {account_id: number}) => a.account_id === bank).balance).toBe(1700);
      await use({ bank, expense });
    } finally {
      for (const id of transactionIds) await request.delete(`${api}/transactions/${id}`);
    }
  },
});

ledgerTest("두 단계 가설의 5월 10일 마감과 11일 부모·자식 지출을 검산한다", async ({ page, ledger }) => {
  const { bank, expense } = ledger;
  const parentName = "중첩 검산 부모";
  const parent = await branch(page, parentName, 1);
  await page.getByRole("tab", { name: "가정", exact: true }).click();
  await planned(page, bank, expense, "분기일 지출", 10, 100);
  const form = page.getByRole("form", { name: "시나리오 규칙 추가" });
  await form.getByLabel("내역").fill("부모 지출 규칙");
  await form.getByLabel("어디서 (from)").selectOption(String(bank));
  await form.getByLabel("어디로 (to)").selectOption(String(expense));
  await form.getByLabel("금액/회").fill("20");
  await form.getByLabel("일정").fill("monthly:11");
  await form.getByLabel("규칙 시작일").fill(may(1));
  await form.getByLabel("규칙 종료일").fill(may(11));
  await form.getByRole("button", { name: "규칙 추가" }).click();
  await expect(page.getByRole("row", { name: /부모 지출 규칙/ })).toBeVisible();

  const child = await branch(page, "중첩 검산 자식", 10, parentName);
  await page.getByRole("tab", { name: "가정", exact: true }).click();
  await expect(page.getByRole("row", { name: /부모 지출 규칙/ })).toContainText("읽기 전용");
  await planned(page, bank, expense, "자식 지출", 11, 30);
  await page.getByRole("tab", { name: "개요", exact: true }).click();
  await page.getByRole("button", { name: "표로 보기" }).click();
  const row = (day: number) => page.getByRole("row").filter({ has: page.getByRole("cell", { name: may(day), exact: true }) });
  await expect(row(10).getByRole("cell")).toHaveText([may(10), "₩900", "₩900"]);
  await expect(row(11).getByRole("cell")).toHaveText([may(11), "₩880", "₩850"]);
  await page.goto(parent);
  await page.getByRole("button", { name: "표로 보기" }).click();
  await expect(row(11).getByRole("cell")).toHaveText([may(11), "₩1,000", "₩880"]);

  await page.getByRole("tab", { name: "가정", exact: true }).click();
  await page.getByRole("row", { name: /부모 지출 규칙/ }).getByRole("button", { name: "수정" }).click();
  const edit = page.getByRole("form", { name: "부모 지출 규칙 수정" });
  await edit.getByLabel("금액/회").fill("25");
  await edit.getByRole("button", { name: "규칙 저장" }).click();
  await expect(page.getByRole("row", { name: /부모 지출 규칙/ })).toContainText("₩25");
  await page.goto(child);
  await page.getByRole("button", { name: "표로 보기" }).click();
  await expect(row(11).getByRole("cell")).toHaveText([may(11), "₩875", "₩845"]);
});
