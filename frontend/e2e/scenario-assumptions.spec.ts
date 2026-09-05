import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "./test";
import AxeBuilder from "@axe-core/playwright";
const API = (
  process.env.MONEYMAP_E2E_API_BASE ??
  `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? "8765"}/api`
).replace(/\/+$/, "");
async function setup(request: APIRequestContext, name: string) {
  const scenario = (
    await (
      await request.post(`${API}/scenarios`, {
        data: { name, fork_date: "2026-01-31" },
      })
    ).json()
  ).scenario;
  const accounts = [];
  for (const [label, type] of [
    ["은행", "asset"],
    ["급여", "income"],
  ])
    accounts.push(
      await (
        await request.post(`${API}/accounts`, {
          data: { name: `${name}-${label}`, type },
        })
      ).json(),
    );
  const body = {
    date: "2026-02-10",
    description: `${name}-예정`,
    postings: accounts.map((a, i) => ({
      account_id: a.id,
      amount: i ? -100 : 100,
      currency: "KRW",
    })),
    scenario_version: 1,
  };
  return {
    scenario,
    accounts,
    body,
    path: `${API}/scenarios/${scenario.id}/planned-transactions`,
  };
}
async function fill(
  page: Page,
  accounts: { id: number }[],
  description: string,
) {
  await page.getByLabel("예정 거래 내역", { exact: true }).fill(description);
  await page.getByLabel("예정 거래 날짜").fill("2026-02-10");
  for (let i = 0; i < 2; i++) {
    await page
      .getByLabel(`분개 ${i + 1} 계정`, { exact: true })
      .selectOption(String(accounts[i].id));
    await page
      .getByLabel(`분개 ${i + 1} 금액 (부호 포함)`, { exact: true })
      .fill(i ? "-100" : "100");
  }
}

test("예정 거래 생성·분개 교체·복제·삭제·읽기 전용", async ({
  page,
  request,
}) => {
  const { scenario, accounts, path } = await setup(request, "PR3-전체");
  await page.goto(`/scenarios/${scenario.id}/assumptions`);
  await fill(page, accounts, "예정 급여");
  await page.getByRole("button", { name: "예정 거래 저장" }).click();
  const table = page.getByRole("table", { name: "시나리오 예정 거래" });
  await expect(table).toContainText("예정 급여");
  const tid = (await (await request.get(path)).json())[0].id;
  await table.getByRole("button", { name: "수정", exact: true }).click();
  await page.getByLabel("예정 거래 내역", { exact: true }).fill("분개 교체");
  await page.getByRole("button", { name: "분개 추가", exact: true }).click();
  await page.getByLabel("분개 1 금액 (부호 포함)", { exact: true }).fill("300");
  await page
    .getByLabel("분개 3 계정", { exact: true })
    .selectOption(String(accounts[1].id));
  await page
    .getByLabel("분개 3 금액 (부호 포함)", { exact: true })
    .fill("-200");
  await page.getByRole("button", { name: "예정 거래 저장" }).click();
  await expect(table).toContainText("분개 교체");
  await table.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/moneymap-planned-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.screenshot({ path: "/tmp/moneymap-planned-720.png", fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const txns = await (await request.get(path)).json();
  expect(txns[0].id).toBe(tid);
  expect(txns[0].postings).toHaveLength(3);
  await page.getByRole("tab", { name: "정보", exact: true }).click();
  await page.getByLabel("복제 이름").fill("PR3-복사본");
  await page.getByRole("button", { name: "복제 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: "PR3-복사본", exact: true }),
  ).toBeVisible();
  const copyId = Number(page.url().split("/").at(-1));
  expect(copyId).not.toBe(scenario.id);
  const copied = await (
    await request.get(`${API}/scenarios/${copyId}/planned-transactions`)
  ).json();
  expect(copied[0].postings).toEqual(txns[0].postings);
  expect(copied[0].id).not.toBe(tid);
  await page.getByRole("tab", { name: "가정", exact: true }).click();
  await table.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(
    page.getByText("예정 거래가 없습니다.", { exact: true }),
  ).toBeVisible();
  expect(await (await request.get(path)).json()).toHaveLength(1);
  await request.post(`${API}/scenarios/${scenario.id}/archive`, {
    data: { version: 3 },
  });
  await page.goto(`/scenarios/${scenario.id}/assumptions`);
  await expect(table).toContainText("분개 교체");
  await expect(
    page.getByRole("button", { name: "예정 거래 저장" }),
  ).toHaveCount(0);
  await expect(table.getByRole("button")).toHaveCount(0);
});

test("복제 날짜 충돌은 목록과 입력을 보존하고 키보드로 복구한다", async ({
  page,
  request,
}) => {
  const { scenario, body, path } = await setup(request, "PR3-복제충돌");
  await request.post(path, { data: body });
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.goto(`/scenarios/${scenario.id}/info`);
  await page.getByLabel("복제 이름").fill("충돌 후 복사");
  await page.getByLabel("복제 시작 기준일").fill("2026-02-10");
  await page.getByRole("button", { name: "복제 만들기" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText(body.description);
  await expect(page.getByLabel("복제 이름")).toHaveValue("충돌 후 복사");
  await expect(page.getByRole("button", { name: "복제 만들기" })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("복제 시작 기준일").fill("2026-01-30");
  await page.getByRole("button", { name: "복제 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: "충돌 후 복사", exact: true }),
  ).toBeVisible();
});

test("예정 거래 오류·버전 충돌에서 초안을 보존하고 명시적으로 재시도한다", async ({
  page,
  request,
}) => {
  const { scenario, accounts, path } = await setup(request, "PR3-초안");
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.goto(`/scenarios/${scenario.id}/assumptions`);
  await fill(page, accounts, "보존할 초안");
  await page.getByLabel("분개 1 금액 (부호 포함)", { exact: true }).fill("99");
  await page.getByRole("button", { name: "예정 거래 저장" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "예정 거래 저장" }),
  ).toBeFocused();
  await expect(page.getByLabel("예정 거래 내역", { exact: true })).toHaveValue(
    "보존할 초안",
  );
  await page.getByLabel("분개 1 금액 (부호 포함)", { exact: true }).fill("100");
  await request.patch(`${API}/scenarios/${scenario.id}`, {
    data: { name: "PR3-초안 최신", description: "", version: 1 },
  });
  await page.getByRole("button", { name: "예정 거래 저장" }).click();
  await expect(page.getByRole("alert")).toContainText("다른 변경");
  await page
    .getByRole("button", {
      name: "입력을 유지하고 최신 버전 확인",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "PR3-초안 최신", exact: true }),
  ).toBeVisible();
  expect(await (await request.get(path)).json()).toEqual([]);
  await expect(page.getByLabel("예정 거래 내역", { exact: true })).toHaveValue(
    "보존할 초안",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "예정 거래 저장" }).click();
  await expect(
    page.getByRole("table", { name: "시나리오 예정 거래" }),
  ).toContainText("보존할 초안");
  expect(await (await request.get(path)).json()).toHaveLength(1);
});

for (const action of ["create", "update", "duplicate"] as const) {
  test(`${action} 응답 대기 중 입력 잠금과 화면 이탈 후 완료 무시`, async ({
    page,
    request,
  }) => {
    const { scenario, accounts, body, path } = await setup(
      request,
      `PR3-대기-${action}`,
    );
    let tid: number | undefined;
    if (action === "update")
      tid = (await (await request.post(path, { data: body })).json())
        .transaction.id;
    await page.goto(
      `/scenarios/${scenario.id}/${action === "duplicate" ? "info" : "assumptions"}`,
    );
    if (action === "update")
      await page
        .getByRole("table", { name: "시나리오 예정 거래" })
        .getByRole("button", { name: "수정", exact: true })
        .click();
    if (action !== "duplicate") await fill(page, accounts, "응답 대기 초안");
    let started!: () => void;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const endpoint =
      action === "duplicate"
        ? `${API}/scenarios/${scenario.id}/duplicate`
        : action === "update"
          ? `${path}/${tid}`
          : path;
    await page.route(endpoint, async (route) => {
      if (route.request().method() === "GET") return route.continue();
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    await page
      .getByRole("button", {
        name: action === "duplicate" ? "복제 만들기" : "예정 거래 저장",
      })
      .click();
    await pending;
    await expect(
      page.getByLabel(action === "duplicate" ? "복제 이름" : "예정 거래 내역", {
        exact: true,
      }),
    ).toBeDisabled();
    if (action === "duplicate") {
      await expect(page.getByRole("button", { name: "보관", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "정보 저장", exact: true })).toBeDisabled();
      await expect(page.getByLabel("이름", { exact: true })).toBeDisabled();
    }
    if (action === "update")
      await expect(
        page.getByRole("button", { name: "수정 취소", exact: true }),
      ).toBeDisabled();
    await page
      .getByRole("link", { name: "시나리오 목록", exact: true })
      .click();
    // Router transitions may update history before the destination commits.
    // Keep the response held until the source editor has actually unmounted.
    await expect(page.getByRole("heading", { name: "시나리오", exact: true })).toBeFocused();
    await expect(page.getByLabel(action === "duplicate" ? "복제 이름" : "예정 거래 내역", { exact: true })).toHaveCount(0);
    const completed = page.waitForEvent("requestfinished", {
      predicate: pending => pending.url() === endpoint && pending.method() !== "GET",
    });
    release();
    await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/\/scenarios$/);
    await expect(
      page.getByRole("heading", { name: "시나리오", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/scenarios$/);
  });
}

test("복제 버전 충돌은 자동 복사 없이 입력을 보존한다", async ({ page, request }) => {
  const { scenario } = await setup(request, "PR3-복제버전");
  await page.goto(`/scenarios/${scenario.id}/info`);
  await page.getByLabel("복제 이름").fill("복제 버전 초안");
  await request.patch(`${API}/scenarios/${scenario.id}`, { data: { name: "PR3-복제버전 최신", version: 1 } });
  let mutations = 0;
  page.on("request", req => { if (req.url().endsWith(`/${scenario.id}/duplicate`) && req.method() === "POST") mutations++; });
  await page.getByRole("button", { name: "복제 만들기" }).click();
  await expect(page.getByRole("alert")).toContainText("다른 변경");
  await page.getByRole("button", { name: "입력을 유지하고 최신 버전 확인" }).click();
  await expect(page.getByRole("heading", { name: "PR3-복제버전 최신", exact: true })).toBeVisible();
  expect(mutations).toBe(1);
  await expect(page.getByLabel("복제 이름")).toHaveValue("복제 버전 초안");
  await page.getByRole("button", { name: "복제 만들기" }).click();
  await expect(page.getByRole("heading", { name: "복제 버전 초안", exact: true })).toBeVisible();
  expect(mutations).toBe(2);
});

test("예정 거래 조회 실패 복구와 오래된 삭제 ETag 재확인", async ({ page, request }) => {
  const { scenario, body, path } = await setup(request, "PR3-조회삭제");
  await request.post(path, { data: body });
  let failed = true;
  await page.route(path, route => failed ? route.fulfill({ status: 503, json: { detail: { code: "unavailable", message: "예정 거래 조회 실패" } } }) : route.continue());
  await page.goto(`/scenarios/${scenario.id}/assumptions`);
  await expect(page.getByRole("alert")).toContainText("예정 거래 조회 실패");
  await expect(page.getByText("예정 거래가 없습니다.", { exact: true })).toHaveCount(0);
  failed = false;
  await page.getByRole("button", { name: "예정 거래 다시 불러오기" }).click();
  const table = page.getByRole("table", { name: "시나리오 예정 거래" });
  await expect(table).toContainText(body.description);
  await request.patch(`${API}/scenarios/${scenario.id}`, { data: { name: "PR3-조회삭제 최신", version: 2 } });
  await table.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await (await request.get(path)).json()).toHaveLength(1);
  await page.getByRole("button", { name: "입력을 유지하고 최신 버전 확인" }).click();
  await expect(page.getByRole("heading", { name: "PR3-조회삭제 최신", exact: true })).toBeVisible();
  await expect(table).toContainText(body.description);
  expect(await (await request.get(path)).json()).toHaveLength(1);
  await table.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.getByText("예정 거래가 없습니다.", { exact: true })).toBeVisible();
});
