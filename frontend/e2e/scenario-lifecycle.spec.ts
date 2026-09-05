import { blockExternalStyles, expect, test, type APIRequestContext } from "./test";
import AxeBuilder from "@axe-core/playwright";

const API = (
  process.env.MONEYMAP_E2E_API_BASE ??
  `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? "8765"}/api`
).replace(/\/+$/, "");
async function create(request: APIRequestContext, name: string) {
  const response = await request.post(`${API}/scenarios`, {
    data: { name, description: "골든 계획", fork_date: "2026-01-31" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).scenario;
}

test("생성부터 추가 가정·정보·보관·복원·삭제까지", async ({
  page,
  request,
}) => {
  const cash = await (
    await request.post(`${API}/accounts`, {
      data: { name: "시나리오-E2E-은행", type: "asset" },
    })
  ).json();
  const income = await (
    await request.post(`${API}/accounts`, {
      data: { name: "시나리오-E2E-수입", type: "income" },
    })
  ).json();
  await page.goto("/scenarios");
  await page.getByLabel("이름", { exact: true }).fill("시나리오 골든");
  await page.getByLabel("시작 기준일", { exact: true }).fill("2026-01-31");
  await page.getByRole("button", { name: "+ 새 시나리오" }).click();
  await expect(page).toHaveURL(/\/scenarios\/\d+$/);
  const sid = Number(page.url().split("/").at(-1));
  let deletingNow = false;
  let deletedDetailReads = 0;
  page.on("request", (request) => {
    if (request.url() !== `${API}/scenarios/${sid}`) return;
    if (request.method() === "DELETE") deletingNow = true;
    if (deletingNow && request.method() === "GET") deletedDetailReads++;
  });

  await expect(
    page.getByText("아직 시나리오 전용 가정이 없습니다", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "6개월", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "현금성 잔액" })).toHaveCount(
    1,
  );
  await page.getByRole("tab", { name: "개요", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "가정", exact: true }),
  ).toBeFocused();
  const form = page.getByRole("form", { name: "시나리오 규칙 추가" });
  await form.getByLabel("내역", { exact: true }).fill("추가 월급");
  await form.getByLabel("어디서 (from)").selectOption(String(income.id));
  await form.getByLabel("어디로 (to)").selectOption(String(cash.id));
  await form.getByLabel("금액/회").fill("1000");
  await form.getByLabel("규칙 시작일").fill("2026-02-01");
  await form.getByRole("button", { name: "규칙 추가", exact: true }).click();
  await expect(page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "규칙", exact: true }) })).toContainText("추가 월급");
  await page.getByRole("tab", { name: "개요", exact: true }).click();
  await expect(page.locator(".scenario-summary")).toContainText("+₩6,000");
  await page.getByRole("button", { name: "3개월", exact: true }).click();
  await expect(page.locator(".scenario-summary")).toContainText("+₩3,000");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "시나리오 골든", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "정보", exact: true }).click();
  await page.getByLabel("이름", { exact: true }).fill("시나리오 이름 수정");
  await page.getByRole("button", { name: "정보 저장" }).click();
  await expect(
    page.getByRole("heading", { name: "시나리오 이름 수정", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "보관", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "복원", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("moneymap.chart_scenarios") ?? "[]"),
    ),
  ).not.toContain(sid);
  await expect(page.getByLabel("이름", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "복원", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/scenarios/${sid}$`));
  await page.getByRole("tab", { name: "정보", exact: true }).click();
  await page.getByRole("button", { name: "보관", exact: true }).click();
  await page.getByRole("button", { name: "영구 삭제…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "시나리오 영구 삭제" }),
  ).toBeFocused();
  await expect(dialog).toContainText("1개");
  const bounds = (await dialog.boundingBox())!;
  await page.mouse.click(bounds.x + 4, bounds.y + 4);
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(() =>
      document.querySelector("dialog")?.contains(document.activeElement),
    ),
  ).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "영구 삭제…" })).toBeFocused();
  await page.getByRole("button", { name: "영구 삭제…" }).click();
  await page.mouse.click(4, 4);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "영구 삭제…" })).toBeFocused();
  await page.getByRole("button", { name: "영구 삭제…" }).click();
  await dialog.getByRole("button", { name: "영구 삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/scenarios\/archived$/);
  await expect(
    page.getByRole("heading", { name: "시나리오 보관함" }),
  ).toBeFocused();
  expect(deletedDetailReads).toBe(0);
  expect((await request.get(`${API}/scenarios/${sid}`)).status()).toBe(404);
});

test("삭제 영향 충돌은 자동 재삭제하지 않고 재확인을 요구한다", async ({
  page,
  request,
}) => {
  const scenario = await create(request, "영향 재확인");
  await request.post(`${API}/scenarios/${scenario.id}/archive`, {
    data: { version: 1 },
  });
  await page.goto(`/scenarios/${scenario.id}/info`);
  await page.getByRole("button", { name: "영구 삭제…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "영구 삭제", exact: true }),
  ).toBeEnabled();
  await request.post(`${API}/scenarios/${scenario.id}/restore`, {
    data: { version: 2 },
  });
  await request.patch(`${API}/scenarios/${scenario.id}`, {
    data: { name: "변경된 삭제 대상", description: "", version: 3 },
  });
  await request.post(`${API}/scenarios/${scenario.id}/archive`, {
    data: { version: 4 },
  });
  let deletes = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE") deletes++;
  });
  await dialog.getByRole("button", { name: "영구 삭제", exact: true }).click();
  await expect(dialog).toContainText("삭제 영향이 변경됐습니다");
  await expect(dialog).toContainText("변경된 삭제 대상");
  await expect(dialog.getByRole("button", { name: "영구 삭제", exact: true })).toBeFocused();
  expect(deletes).toBe(1);
  expect((await request.get(`${API}/scenarios/${scenario.id}`)).status()).toBe(
    200,
  );
  await dialog.getByRole("button", { name: "영구 삭제", exact: true }).click();
  await expect(page).toHaveURL(/\/scenarios\/archived$/);
  expect(deletes).toBe(2);
});

test("삭제 503 오류는 포커스를 복구하고 명시적 재시도만 한 번 실행한다", async ({ page, request }) => {
  const scenario = await create(request, "삭제 오류 복구");
  const url = `${API}/scenarios/${scenario.id}`;
  expect((await request.post(`${url}/archive`, { data: { version: 1 } })).ok()).toBeTruthy();
  await page.goto(`/scenarios/${scenario.id}/info`);
  await page.getByRole("button", { name: "영구 삭제…" }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "영구 삭제", exact: true });
  await expect(confirm).toBeEnabled();
  let deletes = 0;
  let forwardedDeletes = 0;
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/scenarios/${scenario.id}`, async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes++;
    if (deletes === 1) {
      await held;
      await route.fulfill({ status: 503, json: { detail: "일시적인 삭제 오류" } });
    } else {
      forwardedDeletes++;
      await route.continue();
    }
  });
  try {
    await confirm.click();
    await expect.poll(() => deletes).toBe(1);
    await expect(confirm).toBeDisabled();
    await confirm.evaluate(button => (button as HTMLButtonElement).click());
    expect(deletes).toBe(1);
    release();
    await expect(dialog.getByRole("alert")).toContainText("일시적인 삭제 오류");
    await expect(confirm).toBeFocused();
    expect(deletes).toBe(1);
    expect(forwardedDeletes).toBe(0);
    expect((await request.get(url)).status()).toBe(200);
    await confirm.click();
    await expect(page).toHaveURL(/\/scenarios\/archived$/);
    expect(deletes).toBe(2);
    expect(forwardedDeletes).toBe(1);
    expect((await request.get(url)).status()).toBe(404);
  } finally {
    release();
  }
});

test("직접 링크·뒤로가기·404·720px·axe", async ({ page, request }) => {
  const scenario = await create(
    request,
    "아주 긴 시나리오 이름과 직접 링크 확인 ".repeat(8),
  );
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(`/scenarios/${scenario.id}`);
  await expect(page.locator(".scenario-summary")).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 720);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("tab", { name: "정보", exact: true }).click();
  await page.goBack();
  await expect(
    page.getByRole("tab", { name: "개요", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goto("/missing-page");
  await expect(
    page.getByRole("heading", { name: "페이지를 찾을 수 없습니다" }),
  ).toBeVisible();
  await page.goto("/scenarios/999999");
  await expect(
    page.getByRole("heading", { name: "시나리오를 불러올 수 없습니다" }),
  ).toBeVisible();
});

test("늦은 전망 응답을 버리고 선택한 기간만 표시한다", async ({
  page,
  request,
}) => {
  const scenario = await create(request, "응답 순서");
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    `**/api/projection?scenario_id=${scenario.id}&months=6`,
    async (route) => {
      const response = await route.fetch();
      started();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
        /* request was aborted by selection */
      }
    },
  );
  await page.goto(`/scenarios/${scenario.id}`);
  await waiting;
  await page.getByRole("button", { name: "3개월", exact: true }).click();
  await expect(page.locator(".scenario-summary")).toContainText(
    "3개월 뒤 예상",
  );
  release();
  await expect(page.locator(".scenario-summary")).not.toContainText(
    "6개월 뒤 예상",
  );
});

test("legacy 가정은 명시적으로 분류한 뒤 새 전망을 연다", async ({
  page,
  request,
}) => {
  const { execFileSync } = await import("node:child_process");
  const scenario = await create(request, "기존 계획 변환");
  const cash = await (
    await request.post(`${API}/accounts`, {
      data: { name: "legacy-E2E-bank", type: "asset" },
    })
  ).json();
  const salary = await (
    await request.post(`${API}/accounts`, {
      data: { name: "legacy-E2E-income", type: "income" },
    })
  ).json();
  const rule = {
    description: "이전 복사 급여",
    from_account_id: salary.id,
    to_account_id: cash.id,
    amount: 1000,
    schedule: "monthly:25",
    start_date: "2026-02-01",
  };
  await request.post(`${API}/rules`, {
    data: { ...rule, start_date: "2999-01-01" },
  });
  const local = await (
    await request.post(`${API}/scenarios/${scenario.id}/rules`, {
      data: { ...rule, scenario_version: 1 },
    })
  ).json();
  // Historical fixture insertion only in the isolated Playwright DB, never a reset API.
  if (process.env.MONEYMAP_E2E_API_BASE)
    throw new Error("Legacy fixture requires the isolated Playwright database");
  const path = `/tmp/moneymap-e2e-${process.env.MONEYMAP_E2E_BACKEND_PORT ?? "8765"}/moneymap.db`;
  execFileSync("python3", [
    "-c",
    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE scenarios SET rule_mode='legacy_snapshot' WHERE id=?\", (int(sys.argv[2]),)); c.commit(); c.close()",
    path,
    String(scenario.id),
  ]);
  await page.goto(`/scenarios/${scenario.id}`);
  await expect(
    page.getByRole("heading", { name: "기존 가정 분류" }),
  ).toBeVisible();
  const submit = page.getByRole("button", {
    name: "분류 확정 후 새 전망 보기",
  });
  await expect(submit).toBeDisabled();
  await expect(
    page.getByRole("radio", { name: "snapshot 폐기" }),
  ).not.toBeChecked();
  await page.getByRole("radio", { name: "snapshot 폐기" }).check();
  await submit.click();
  await expect(page.locator(".scenario-summary")).toContainText("+₩0");
  const effective = await (
    await request.get(`${API}/scenarios/${scenario.id}/effective-rules`)
  ).json();
  expect(
    effective.some(
      (entry: { rule: { id: number } }) => entry.rule.id === local.rule.id,
    ),
  ).toBe(false);
});

test("정보 저장 충돌에서도 초안과 포커스를 유지한다", async ({
  page,
  request,
}) => {
  const scenario = await create(request, "정보 충돌");
  await page.goto(`/scenarios/${scenario.id}/info`);
  const name = page.getByLabel("이름", { exact: true });
  await name.fill("보존할 초안");
  await request.patch(`${API}/scenarios/${scenario.id}`, {
    data: { name: "다른 탭", description: "", version: 1 },
  });
  const save = page.getByRole("button", { name: "정보 저장" });
  await save.click();
  await expect(page.getByRole("alert")).toContainText("최신 내용을 확인");
  await expect(name).toHaveValue("보존할 초안");
  await expect(save).toBeFocused();
  await page
    .getByRole("button", { name: "입력을 유지하고 최신 버전 확인" })
    .click();
  await expect(
    page.getByRole("heading", { name: "다른 탭", exact: true }),
  ).toBeVisible();
  await expect(name).toHaveValue("보존할 초안");
  await save.click();
  await expect(
    page.getByRole("heading", { name: "보존할 초안", exact: true }),
  ).toBeVisible();
});

test("규칙 수정 충돌은 초안을 유지하고 최신 버전 확인 후 재시도한다", async ({
  page,
  request,
}) => {
  const scenario = await create(request, "규칙 충돌");
  const cash = await (
    await request.post(`${API}/accounts`, {
      data: { name: "규칙충돌-E2E-은행", type: "asset" },
    })
  ).json();
  const income = await (
    await request.post(`${API}/accounts`, {
      data: { name: "규칙충돌-E2E-수입", type: "income" },
    })
  ).json();
  const created = await request.post(`${API}/scenarios/${scenario.id}/rules`, {
    data: {
      scenario_version: 1,
      description: "수정할 규칙",
      from_account_id: income.id,
      to_account_id: cash.id,
      amount: 1000,
      schedule: "monthly:25",
      start_date: "2026-02-01",
    },
  });
  expect(created.ok()).toBeTruthy();
  const { rule } = await created.json();
  await page.goto(`/scenarios/${scenario.id}/assumptions`);
  await page
    .getByRole("row")
    .filter({ hasText: "수정할 규칙" })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  const form = page.getByRole("form", {
    name: "수정할 규칙 수정",
    exact: true,
  });
  await form.getByLabel("내역", { exact: true }).fill("보존할 규칙 초안");
  await form.getByLabel("금액/회").fill("2300");
  await form.getByLabel("일정", { exact: true }).fill("monthly:17");
  const changed = await request.patch(`${API}/scenarios/${scenario.id}`, {
    data: { name: "규칙 충돌 최신 버전", description: "", version: 2 },
  });
  expect(changed.ok()).toBeTruthy();
  const save = form.getByRole("button", { name: "규칙 저장", exact: true });
  await save.click();
  await expect(form.getByRole("alert")).toContainText("최신 내용을 확인");
  await expect(save).toBeFocused();
  await expect(form.getByLabel("내역", { exact: true })).toHaveValue(
    "보존할 규칙 초안",
  );
  await expect(form.getByLabel("금액/회")).toHaveValue("2300");
  await form
    .getByRole("button", { name: "입력을 유지하고 최신 버전 확인" })
    .click();
  await expect(
    page.getByRole("heading", { name: "규칙 충돌 최신 버전", exact: true }),
  ).toBeVisible();
  await expect(form.getByLabel("내역", { exact: true })).toHaveValue(
    "보존할 규칙 초안",
  );
  await expect(form.getByLabel("금액/회")).toHaveValue("2300");
  await expect(form.getByLabel("일정", { exact: true })).toHaveValue(
    "monthly:17",
  );
  await save.click();
  await expect(
    page.getByRole("row").filter({ hasText: "보존할 규칙 초안" }),
  ).toContainText("₩2,300");
  const effective = await (
    await request.get(`${API}/scenarios/${scenario.id}/effective-rules`)
  ).json();
  expect(
    effective.find(
      (entry: { rule: { id: number } }) => entry.rule.id === rule.id,
    ).rule,
  ).toMatchObject({
    description: "보존할 규칙 초안",
    amount: { amount: 2300 },
    schedule: { spec: "monthly:17" },
  });
});

test("메타데이터 재조회는 늦은 이전 응답을 취소하고 최신 버전으로 저장한다", async ({
  page,
  request,
}) => {
  const scenario = await create(request, "메타데이터 응답 순서");
  const url = `${API}/scenarios/${scenario.id}`;
  await page.goto(`/scenarios/${scenario.id}/info`);
  const name = page.getByLabel("이름", { exact: true });
  await name.fill("응답 순서 보존 초안");
  expect(
    (
      await request.patch(url, {
        data: { name: "이전 메타데이터", description: "", version: 1 },
      })
    ).ok(),
  ).toBeTruthy();
  const save = page.getByRole("button", { name: "정보 저장" });
  await save.click();
  const reload = page.getByRole("button", {
    name: "입력을 유지하고 최신 버전 확인",
  });
  await expect(reload).toBeVisible();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    `**/api/scenarios/${scenario.id}`,
    async (route) => {
      const response = await route.fetch();
      started();
      await held;
      try {
        await route.fulfill({ response });
      } catch {
        /* superseded metadata request was aborted */
      }
    },
    { times: 1 },
  );
  try {
    await reload.click();
    await waiting;
    expect(
      (
        await request.patch(url, {
          data: { name: "최신 메타데이터", description: "", version: 2 },
        })
      ).ok(),
    ).toBeTruthy();
    const aborted = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.url() === url && request.method() === "GET",
    });
    await reload.click();
    await aborted;
    await expect(
      page.getByRole("heading", { name: "최신 메타데이터", exact: true }),
    ).toBeVisible();
    release();
    await expect(name).toHaveValue("응답 순서 보존 초안");
    await save.click();
    await expect(
      page.getByRole("heading", { name: "응답 순서 보존 초안", exact: true }),
    ).toBeVisible();
    expect(await (await request.get(url)).json()).toMatchObject({
      name: "응답 순서 보존 초안",
      version: 4,
    });
  } finally {
    release();
  }
});

test("서울 날짜와 시작 기준일을 차트 표에서 그대로 표시한다", async ({
  browser,
  request,
}) => {
  const scenario = await create(request, "서울 날짜 경계");
  const context = await browser.newContext({ timezoneId: "Asia/Seoul" });
  const page = await context.newPage();
  await blockExternalStyles(page);
  await page.goto(
    `http://127.0.0.1:${process.env.MONEYMAP_E2E_FRONTEND_PORT ?? "5173"}/scenarios/${scenario.id}`,
  );
  await expect(
    page.locator("svg text").getByText("시작 기준일", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "표로 보기" }).click();
  await expect(
    page.locator("table").first().locator("tbody tr").first(),
  ).toContainText("2026-01-31");
  await context.close();
});

for (const action of ["update", "archive", "restore"] as const) {
  test(`늦은 ${action} 응답은 다른 시나리오 정보 화면을 덮어쓰거나 이동시키지 않는다`, async ({ page, request }) => {
    const source = await create(request, `이전 화면 ${action}`);
    const target = await create(request, `유지할 화면 ${action}`);
    if (action === "restore") {
      expect((await request.post(`${API}/scenarios/${source.id}/archive`, { data: { version: 1 } })).ok()).toBeTruthy();
    }
    await page.goto(`/scenarios/${target.id}/info`);
    await expect(page.getByRole("heading", { name: target.name, exact: true })).toBeVisible();
    // Put adjacent detail routes in browser history without remounting the app.
    await page.evaluate(path => {
      history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1 }, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/scenarios/${source.id}/info`);
    await expect(page.getByRole("heading", { name: source.name, exact: true })).toBeVisible();
    const mutationUrl = `${API}/scenarios/${source.id}${action === "update" ? "" : `/${action}`}`;
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let started: () => void = () => {};
    const waiting = new Promise<void>(resolve => { started = resolve; });
    await page.route(mutationUrl, async route => {
      if (route.request().method() === "GET") return route.continue();
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    try {
      if (action === "update") await page.getByLabel("이름", { exact: true }).fill("이전 화면 저장 완료");
      await page.getByRole("button", { name: action === "update" ? "정보 저장" : action === "archive" ? "보관" : "복원", exact: true }).click();
      await waiting;
      await page.goBack();
      await expect(page.getByRole("heading", { name: target.name, exact: true })).toBeVisible();
      await page.getByLabel("이름", { exact: true }).fill("현재 화면의 보존할 초안");
      let staleReads = 0;
      page.on("request", pending => {
        if (pending.method() === "GET" && pending.url() === `${API}/scenarios/${source.id}`) staleReads++;
      });
      const completed = page.waitForEvent("requestfinished", { predicate: pending => pending.url() === mutationUrl && pending.method() !== "GET" });
      release();
      await completed;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page).toHaveURL(new RegExp(`/scenarios/${target.id}/info$`));
      await expect(page.getByRole("heading", { name: target.name, exact: true })).toBeVisible();
      await expect(page.getByLabel("이름", { exact: true })).toHaveValue("현재 화면의 보존할 초안");
      expect(staleReads).toBe(0);
      const saved = await (await request.get(`${API}/scenarios/${source.id}`)).json();
      expect(saved).toMatchObject(action === "update" ? { name: "이전 화면 저장 완료" } : { status: action === "archive" ? "archived" : "active" });
    } finally {
      release();
    }
  });
}

for (const mode of ["create", "edit"] as const) {
  test(`규칙 ${mode} 저장 대기 중에는 입력과 편집 전환을 잠근다`, async ({ page, request }) => {
    const scenario = await create(request, `저장 중 보호 ${mode}`);
    const cash = await (await request.post(`${API}/accounts`, { data: { name: `저장보호-은행-${mode}`, type: "asset" } })).json();
    const income = await (await request.post(`${API}/accounts`, { data: { name: `저장보호-수입-${mode}`, type: "income" } })).json();
    const ruleBody = { description: "저장 대기 규칙", from_account_id: income.id, to_account_id: cash.id, amount: 1000, schedule: "monthly:25", start_date: "2026-02-01", scenario_version: 1 };
    let rid: number | undefined;
    if (mode === "edit") {
      const result = await request.post(`${API}/scenarios/${scenario.id}/rules`, { data: ruleBody });
      expect(result.ok()).toBeTruthy();
      rid = (await result.json()).rule.id;
    }
    await page.goto(`/scenarios/${scenario.id}/assumptions`);
    if (mode === "edit") await page.getByRole("row").filter({ hasText: ruleBody.description }).getByRole("button", { name: "수정", exact: true }).click();
    const form = page.getByRole("form", { name: mode === "edit" ? `${ruleBody.description} 수정` : "시나리오 규칙 추가", exact: true });
    await form.getByLabel("내역", { exact: true }).fill("저장할 규칙 값");
    await form.getByLabel("어디서 (from)").selectOption(String(income.id));
    await form.getByLabel("어디로 (to)").selectOption(String(cash.id));
    await form.getByLabel("금액/회").fill("2300");
    await form.getByLabel("규칙 시작일").fill("2026-02-01");
    const url = `${API}/scenarios/${scenario.id}/rules${rid ? `/${rid}` : ""}`;
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let started: () => void = () => {};
    const waiting = new Promise<void>(resolve => { started = resolve; });
    await page.route(url, async route => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    try {
      await form.getByRole("button", { name: mode === "edit" ? "규칙 저장" : "규칙 추가", exact: true }).click();
      await waiting;
      for (const control of await form.locator("input, select, button").all()) await expect(control).toBeDisabled();
      if (mode === "edit") {
        await expect(page.getByRole("row").filter({ hasText: ruleBody.description }).getByRole("button", { name: "수정", exact: true })).toBeDisabled();
      }
      release();
      await expect(page.getByRole("row").filter({ hasText: "저장할 규칙 값" })).toContainText("₩2,300");
      const next = page.getByRole("form", { name: "시나리오 규칙 추가", exact: true });
      await expect(next.getByLabel("내역", { exact: true })).toBeEnabled();
      await expect(next.getByLabel("내역", { exact: true })).toHaveValue("");
      const effective = await (await request.get(`${API}/scenarios/${scenario.id}/effective-rules`)).json();
      expect(effective.filter((entry: { origin: string }) => entry.origin === "scenario")).toHaveLength(1);
      expect(effective.find((entry: { origin: string }) => entry.origin === "scenario").rule).toMatchObject({ description: "저장할 규칙 값", amount: { amount: 2300 } });
    } finally { release(); }
  });
}

test("늦은 시나리오 생성 응답은 거래 입력의 URL과 초안을 유지한다", async ({ page, request }) => {
  await page.goto("/scenarios");
  await page.getByLabel("이름", { exact: true }).fill("늦게 생성된 계획");
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let sid = 0;
  await page.route(`${API}/scenarios`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    sid = (await response.json()).scenario.id;
    started();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "+ 새 시나리오" }).click();
    await waiting;
    await page.locator(".side nav").getByRole("button", { name: "거래 입력", exact: true }).click();
    await page.getByLabel("금액", { exact: true }).fill("9876");
    await page.getByLabel("아이템 (선택)", { exact: true }).fill("잃으면 안 되는 거래 초안");
    const completed = page.waitForEvent("requestfinished", { predicate: pending => pending.url() === `${API}/scenarios` && pending.method() === "POST" });
    release();
    await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/\/transactions\/new$/);
    await expect(page.getByLabel("금액", { exact: true })).toHaveValue("9,876");
    await expect(page.getByLabel("아이템 (선택)", { exact: true })).toHaveValue("잃으면 안 되는 거래 초안");
    expect((await request.get(`${API}/scenarios/${sid}`)).status()).toBe(200);
  } finally { release(); }
});

test("생성 중 보관함을 거쳐 재방문하면 이전 응답이 새 목록 초안을 건드리지 않는다", async ({ page, request }) => {
  await page.goto("/scenarios");
  await page.getByLabel("이름", { exact: true }).fill("이전 목록에서 만든 계획");
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {};
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let sid = 0;
  await page.route(`${API}/scenarios`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    sid = (await response.json()).scenario.id;
    started();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: "+ 새 시나리오" }).click();
    await waiting;
    for (const control of await page.locator(".scenario-create input").all()) await expect(control).toBeDisabled();
    await page.getByRole("link", { name: "보관함", exact: true }).click();
    await expect(page.getByRole("heading", { name: "시나리오 보관함", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "활성 시나리오", exact: true }).click();
    await page.getByLabel("이름", { exact: true }).fill("새 방문의 보존할 초안");
    await expect(page.getByRole("button", { name: "+ 새 시나리오" })).toBeEnabled();
    const completed = page.waitForEvent("requestfinished", { predicate: pending => pending.url() === `${API}/scenarios` && pending.method() === "POST" });
    release();
    await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/\/scenarios$/);
    await expect(page.getByLabel("이름", { exact: true })).toHaveValue("새 방문의 보존할 초안");
    await expect(page.getByRole("button", { name: "+ 새 시나리오" })).toBeEnabled();
    expect((await request.get(`${API}/scenarios/${sid}`)).status()).toBe(200);
  } finally { release(); }
});
