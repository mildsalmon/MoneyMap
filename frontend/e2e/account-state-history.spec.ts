import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "./test";

test("Seoul effective dates, corrections and retained references use the migrated ledger", async ({ page }, info) => {
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
  } finally {
    server.kill();
    await exited;
  }
});
