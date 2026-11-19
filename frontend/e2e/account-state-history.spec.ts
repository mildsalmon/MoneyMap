import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test as base } from "./test";

const test = base.extend<{ historyApi: string }>({
  historyApi: async ({ page }, use, info) => {
    const python = execFileSync("uv", ["run", "python", "-c", "import sys; print(sys.executable)"], { cwd: "../backend", encoding: "utf8" }).trim();
    const server = spawn(python, ["tests/fixtures/account_history_ledger.py", info.outputPath("ledger.db")], {
      cwd: "../backend", env: { ...process.env, MONEYMAP_CORS_ORIGINS: String(info.project.use.baseURL) },
    });
    const exited = once(server, "exit");
    try {
      let output = "";
      const origin = await new Promise<string>((resolve, reject) => {
        server.stderr.on("data", chunk => {
          output += chunk.toString();
          const url = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (url) resolve(url[1]);
        });
        server.once("error", reject);
        server.once("exit", () => reject(new Error(output)));
      });
      // Forward to the private FastAPI process. Every response and write is real.
      await page.route(url => url.pathname.startsWith("/api/"), route => {
        const url = new URL(route.request().url());
        return route.continue({ url: origin + url.pathname + url.search });
      });
      await use(origin + "/api");
    } finally {
      server.kill();
      await exited;
    }
  },
});

test("Seoul effective dates, corrections and retained references use the migrated ledger", async ({ page, historyApi }) => {
  expect(historyApi).toContain("127.0.0.1");
  const history = page.locator("details").filter({ has: page.getByText("계정 상태 이력", { exact: true }) });
  await page.goto("/accounts");
  await page.getByText("계정 상태 이력", { exact: true }).click();
  await page.getByLabel("이력을 볼 계정").selectOption("2");
  page.on("dialog", dialog => dialog.accept());
  await page.getByLabel("보관 적용일").fill("2020-06-01");
  await page.getByRole("button", { name: "선택한 날부터 보관" }).click();
  await page.getByLabel("복원 적용일").fill("2020-06-05");
  await page.getByRole("button", { name: "선택한 날부터 복원" }).click();
  await expect(page.getByLabel("보관 적용일")).toBeVisible();

  await page.goto("/transactions/new");
  const bank = page.getByRole("group", { name: "대변 계정", exact: true }).getByRole("radio", { name: /이력 통장$/ });
  async function on(day: string) {
    const loaded = page.waitForResponse(r => r.url().includes("/accounts?on="+day) && r.ok());
    await page.getByLabel("날짜", { exact: true }).fill(day);
    await loaded;
    await expect(page.getByRole("radio", { name: /이력 비용$/ }).first()).toBeVisible();
  }
  await on("2020-05-01");
  await expect(page.getByText(/이력 미상 · 수집 시작/)).toBeVisible();
  await on("2020-05-31"); await expect(bank).toBeVisible();
  await bank.check();
  await page.getByRole("group", { name: "차변 계정", exact: true }).getByRole("radio", { name: /이력 비용$/ }).check();
  await page.getByLabel("금액", { exact: true }).fill("100");
  for (const day of ["01","02","03","04"]) {
    await on("2020-06-"+day);
    await expect(bank).toHaveCount(0);
    await expect(page.getByRole("button", { name: "저장 (Enter)", exact: true })).toBeDisabled();
  }
  await on("2020-06-05"); await expect(bank).toBeChecked();
  const posted = page.waitForResponse(r => r.url().endsWith("/api/transactions") && r.status() === 201);
  await page.getByRole("button", { name: "저장 (Enter)", exact: true }).click();
  expect((await (await posted).json()).date).toBe("2020-06-05");

  await on("2020-06-03");
  await expect(page.getByText("이 거래일에는 사용할 수 없습니다. 다른 계정을 선택하세요.")).toBeVisible();

  await page.goto("/accounts");
  await page.getByText("계정 상태 이력", { exact: true }).click();
  await page.getByLabel("이력을 볼 계정").selectOption("2");
  await history.getByRole("listitem").filter({ has: page.getByText("보관", { exact: true }) }).getByRole("button").click();
  await page.getByLabel("새 적용일").fill("2020-06-03");
  await page.getByRole("button", { name: "정정 저장" }).click();
  await expect(page.getByText("적용일을 정정했습니다.")).toBeVisible();
  await page.goto("/transactions/new"); await on("2020-06-01"); await expect(bank).toBeVisible();
  // Archive again so the pre-baseline edit actually exercises a retained,
  // currently unavailable posting rather than a normally selectable account.
  await page.goto("/accounts");
  await page.getByText("계정 상태 이력", { exact: true }).click();
  await page.getByLabel("이력을 볼 계정").selectOption("2");
  await page.getByLabel("보관 적용일").fill("2020-06-06");
  await page.getByRole("button", { name: "선택한 날부터 보관" }).click();
  await expect(page.getByLabel("복원 적용일")).toBeVisible();
  await page.goto("/transactions/31/edit");
  await expect(page.getByText(/이력 미상 · 수집 시작/)).toBeVisible();
  await page.getByLabel("메모", { exact: false }).fill("이전 계정 연결 유지");
  const edit = page.waitForResponse(r => r.url().endsWith("/api/transactions/31") && r.request().method() === "PUT" && r.ok());
  await page.getByRole("button", { name: "변경사항 저장" }).click();
  expect((await (await edit).json()).transaction.postings.map((p: { posting_id: number }) => p.posting_id)).toEqual([41,42]);
});

test("the account path distinguishes names and a parent correction identifies the linked move", async ({ page, request, historyApi }) => {
  const settings = (id: number, parent: number, version: number) => request.put(`${historyApi}/accounts/${id}/settings`, {
    data: { name: "생활비", parent_id: parent, is_overdraft: false, version },
  });
  expect((await settings(6, 4, 1)).ok()).toBe(true);
  const peer = await request.post(historyApi+"/accounts", { data: { name:"생활비", type:"asset", parent_id:5 } });
  expect(peer.ok()).toBe(true);
  await page.goto("/accounts");
  await page.getByText("계정 상태 이력", { exact: true }).click();
  const picker = page.getByLabel("이력을 볼 계정");
  await expect(picker.getByRole("option", { name: "자산 > 이전 부모 > 생활비" })).toHaveCount(1);
  await expect(picker.getByRole("option", { name: "자산 > 새 그룹 > 생활비" })).toHaveCount(1);
  // Move to the root, leaving the former parent explicitly grouped.
  expect((await request.put(historyApi+"/accounts/6/settings", {
    data:{name:"생활비", parent_id:null, is_overdraft:false, version:2},
  })).ok()).toBe(true);
  await page.reload();
  await page.getByText("계정 상태 이력", { exact: true }).click();
  await picker.selectOption("4");
  const groupEvent = page.getByRole("listitem").filter({ has: page.getByText("그룹 설정", { exact: true }) });
  await groupEvent.getByRole("button", { name:"적용일 정정" }).click();
  await expect(page.getByLabel("함께 정정할 이동")).toContainText("생활비");
  await expect(page.getByLabel("함께 정정할 이동")).toContainText("자산 > 이전 부모 → 최상위");
});

test("installment purchase refuses a stale archive-period preview and saves on restoration", async ({ page, request, historyApi }) => {
  const card = (await (await request.post(historyApi+"/accounts", { data:{name:"이력 카드",type:"liability"} })).json()).id;
  const events = (await (await request.get(`${historyApi}/accounts/${card}/state-history`)).json()).events;
  expect((await request.post(`${historyApi}/accounts/${card}/state-history/${events[0].seq}/corrections`, {
    data:{effective_date:"2020-05-20", expected_revision:0},
  })).ok()).toBe(true);
  await page.goto("/installments");
  await page.getByText("새 할부 구매", { exact:true }).click();
  await page.getByLabel("구매일", { exact:true }).fill("2020-06-03");
  await page.getByLabel("구매 내역").fill("이력 검증 구매");
  await page.getByLabel("구매 계정 (비용·자산)").selectOption("3");
  await page.getByLabel("카드 계정 (부채)").selectOption(String(card));
  await page.getByLabel("납부 통장").selectOption("2");
  await page.getByLabel("구매 총액 (원)").fill("1000");
  await page.getByRole("button", { name:"회차 미리보기" }).click();
  const save = page.getByRole("button", { name:"구매·할부 일정 저장" });
  await expect(save).toBeVisible();
  for (const [action,day] of [["archive","01"],["restore","05"]]) {
    expect((await request.post(`${historyApi}/accounts/${card}/${action}?effective_date=2020-06-${day}`)).ok()).toBe(true);
  }
  await save.click();
  await expect(page.getByRole("alert")).toContainText("거래일");
  await expect(page.getByText("등록한 할부가 없습니다.", {exact:false})).toBeVisible();
  await page.getByLabel("구매일", { exact:true }).fill("2020-06-04");
  await expect(page.getByLabel("카드 계정 (부채)").getByRole("option", {name:"이력 카드"})).toHaveCount(0);
  await page.getByLabel("구매일", { exact:true }).fill("2020-06-05");
  await page.getByLabel("카드 계정 (부채)").selectOption(String(card));
  await page.getByRole("button", { name:"회차 미리보기" }).click();
  await save.click();
  await expect(page.getByRole("heading", {name:"이력 검증 구매"})).toBeVisible();
});

test("a backdated last-child move keeps its former parent out of the June 2 picker", async ({ page, request, historyApi }) => {
  const later = (await (await request.post(historyApi+"/accounts", { data: {name:"6월 5일 자식",type:"asset",parent_id:4} })).json()).id;
  const creation = (await (await request.get(`${historyApi}/accounts/${later}/state-history`)).json()).events[0];
  expect((await request.post(`${historyApi}/accounts/${later}/state-history/${creation.seq}/corrections`, {
    data:{effective_date:"2020-06-05", expected_revision:0},
  })).ok()).toBe(true);
  expect((await request.put(historyApi+"/accounts/6/settings", {
    data:{name:"이동할 계정",parent_id:5,is_overdraft:false,version:1,effective_date:"2020-06-01"},
  })).ok()).toBe(true);
  await page.goto("/transactions/new");
  const loaded = page.waitForResponse(r => r.url().endsWith("/accounts?on=2020-06-02") && r.ok());
  await page.getByLabel("날짜", {exact:true}).fill("2020-06-02");
  await loaded;
  const pick = page.getByRole("group", {name:"차변 계정",exact:true});
  await expect(pick.getByRole("radio", {name:"자산 > 새 그룹 > 이동할 계정"})).toBeVisible();
  await expect(pick.getByRole("radio", {name:"자산 > 이전 부모",exact:true})).toHaveCount(0);
  await expect(pick.getByRole("radio", {name:/6월 5일 자식/})).toHaveCount(0);
});
