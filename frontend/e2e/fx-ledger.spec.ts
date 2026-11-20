import { execFileSync } from "node:child_process";
import { expect, test } from "./test";
import { withLedger } from "./withLedger";

test("현금 환전 · 수량 수정, 수동 평가, 미평가 소계와 전량 매도", async ({ page, request }, info) => {
  await withLedger(page, info.outputPath("fx.db"), "empty", async base => {
    const account = await request.post(base + "/accounts", {data: {name: "합성 원화통장", type: "asset"}});
    expect(account.ok()).toBeTruthy();
    const bank = String((await account.json()).id);
    await page.clock.setFixedTime(new Date("2026-11-20T12:00:00+09:00"));
    await page.goto("/fx");
    const reportDay = page.getByLabel("평가일", {exact:true});
    const quoteDay = page.getByLabel("평가 기준일", {exact:true});
    await expect(reportDay).toHaveValue("2026-11-20");
    await page.getByLabel("거래일", {exact:true}).fill("2026-06-10");
    const save = page.getByRole("button", {name: "환전 저장", exact: true});
    async function record(currency: string, quantity: string, cash: string, fee: string, rate: string, sell = false) {
      await page.getByLabel("매매 구분").selectOption(sell ? "sell" : "buy");
      await page.getByLabel("원화 통장").selectOption(bank);
      await page.getByLabel("거래 통화").selectOption(currency);
      await page.getByLabel("외화 수량").fill(quantity);
      await page.getByLabel(sell ? "실제 입금액" : "실제 출금액").fill(cash);
      await page.getByLabel("수수료 (원)", {exact: true}).fill(fee);
      await page.getByLabel("거래환율 (원/1단위)").fill(rate);
      await page.getByLabel("거래환율 출처").fill("합성 명세서");
      await save.click();
      await expect(page.getByRole("status").filter({hasText: "저장 완료"})).toBeVisible();
    }
    await record("USD", "10.24", "14450", "100", "1400");
    await page.getByRole("button", {name: "환전 #1 수정", exact: true}).click();
    await page.getByLabel("외화 수량").fill("10.25");
    await page.getByRole("button", {name: "수정 저장"}).click();
    await expect(page.getByText("USD 10.25 · 출금 ₩14,450 · 원금 ₩14,350 · 수수료 ₩100")).toBeVisible();
    await page.getByText("수동 평가환율 입력").click();
    await expect(reportDay).toHaveValue("2026-06-10");
    await expect(quoteDay).toHaveValue("2026-06-10");
    await page.getByLabel("평가환율 (원/1단위)").fill("1410");
    await page.getByLabel("평가환율 출처").fill("합성 종가");
    await page.getByRole("button", {name: "평가환율 확정"}).click();
    const usd = page.getByRole("row").filter({hasText:"외화 현금 (USD)"});
    await expect(usd).toContainText("₩14,453");
    await expect(usd).toContainText("₩103");
    await page.reload();
    await expect(reportDay).toHaveValue("2026-06-10");
    await expect(usd).toContainText("₩14,453");
    expect((await (await request.get(base + "/fx?day=2026-06-10")).json()).quotes.USD.rate).toBe("1410");
    expect((await (await request.get(base + "/fx?day=2026-11-20")).json()).quotes).toEqual({});
    await page.getByText("수동 평가환율 입력").click();
    await quoteDay.fill("2026-06-12");
    await reportDay.fill("2026-06-11");
    await expect(quoteDay).toHaveValue("2026-06-12");
    await page.getByLabel("평가환율 (원/1단위)").fill("1420");
    await page.getByLabel("평가환율 출처").fill("별도 기준일");
    await page.getByRole("button", {name:"평가환율 확정"}).click();
    await expect(reportDay).toHaveValue("2026-06-12");
    await reportDay.fill("2026-06-10");
    await expect(quoteDay).toHaveValue("2026-06-10");
    await page.getByLabel("거래일", {exact:true}).fill("2026-06-10");
    await record("JPY", "111", "999", "0", "9");
    await page.getByRole("button", {name: "환전 #2 수정", exact: true}).click();
    await page.getByLabel("외화 수량").fill("112");
    await page.getByLabel("실제 출금액").fill("1008");
    await page.getByRole("button", {name:"수정 저장"}).click();
    await expect(page.getByText("JPY 112 · 출금 ₩1,008 · 원금 ₩1,008 · 수수료 ₩0")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("row").filter({hasText: "외화 현금 (JPY)"})).toContainText("미평가");
    await expect(page.getByText("평가한 외화 소계", {exact:true}).locator("..")).toContainText("₩14,453");
    await expect(page.getByText("평가 가능한 순자산 소계", {exact:true}).locator("..")).toContainText("−₩1,005");
    const day = await page.getByLabel("평가일", {exact:true}).inputValue();
    const ledger = await (await request.get(base + "/fx?day=" + day)).json();
    expect(ledger.trades.map((t: {minor: string}) => t.minor)).toEqual(["112","1025"]);
    await record("USD", "10.25", "14555", "0", "1420", true);
    await expect(usd.getByRole("cell").nth(3)).toHaveText("₩0");
    await expect(usd.getByRole("cell").nth(4)).toHaveText("₩205");
    await expect(usd.getByRole("cell").nth(0)).toContainText("0.00");
    await page.goto(`/transactions?start=${day}&end=${day}`);
    await page.getByRole("link", {name:"환전 #1 보기"}).first().click();
    await expect(page.locator("article#fx-1")).toBeFocused();
  });
});

test("선택한 합성 CSV 행의 이관 미리보기와 백업", async ({ page, request }, info) => {
  const path = info.outputPath("legacy-fx.db");
  await withLedger(page, path, "empty", async base => {
    const create = async (name: string, type: string) => {
      const response = await request.post(base + "/accounts", {data:{name, type}});
      expect(response.ok()).toBeTruthy();
      return (await response.json()).id;
    };
    const bank = await create("명세서 통장", "asset");
    const expense = await create("원화에서달러로환전", "expense");
    execFileSync("uv", ["run", "python", "-c", `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as conn:
    tid = conn.execute("INSERT INTO transactions(scenario_id,date,description) VALUES(1,'2026-06-10','합성 매수')").lastrowid
    conn.executemany("INSERT INTO postings(txn_id,account_id,amount) VALUES(?,?,?)", [(tid,sys.argv[2],-14450),(tid,sys.argv[3],14450)])
    conn.execute("UPDATE transactions SET posted=1 WHERE id=?", (tid,))
    conn.execute("""INSERT INTO transaction_import_provenance(txn_id,source_hash,source_file,source_row,raw_date,raw_description,raw_amount,
        raw_running_total,raw_left_type,raw_left_account,raw_right_type,raw_right_account)
        VALUES(?,?,'synthetic.csv',23,'2026-06-10','합성','14450','0','비용','원화에서달러로환전','자산','명세서 통장')""", (tid,'f'*64))
`, path, String(bank), String(expense)], {cwd: "../backend"});
    await page.goto("/fx");
    await page.getByText("과거 USD 구매 선택 이관").click();
    await page.getByRole("button", {name:"원본 #1 선택"}).click();
    await page.getByLabel("외화 수량").fill("10.25");
    await page.getByLabel("수수료 (원)", {exact:true}).fill("100");
    await page.getByLabel("거래환율 (원/1단위)").fill("1400");
    await page.getByLabel("거래환율 출처").fill("합성 은행");
    await page.getByRole("button", {name:"이관 미리보기"}).click();
    await expect(page.getByText("−₩14,450 → −₩14,450")).toBeVisible();
    await expect(page.getByText("₩14,450 → ₩0")).toBeVisible();
    await page.getByRole("button", {name:"백업 후 이관 확정"}).click();
    await expect(page.getByText("환전 #1 저장 완료")).toBeVisible();
    await page.getByText("원본 행과 백업").click();
    await expect(page.getByText("거래 #1 · synthetic.csv · 23행")).toBeVisible();
    await expect(page.getByText(/백업 legacy-import-.*\.db/)).toBeVisible();
  });
});
