import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API_BASE = (process.env.MONEYMAP_E2E_API_BASE
  ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? "8765"}/api`).replace(/\/+$/, "");

interface TestAccount {
  id: number;
  name: string;
  type: "asset" | "liability" | "income" | "expense" | "equity";
  parent_id: number | null;
  is_overdraft: boolean;
  position: number;
  version: number;
}

function nav(page: Page, label: string) {
  return page.locator(".side nav").getByRole("button", { name: label, exact: true });
}

function accountRow(page: Page, name: string) {
  return page.locator("tr.account-row").filter({ hasText: name }).first();
}

async function accounts(request: APIRequestContext): Promise<TestAccount[]> {
  const response = await request.get(`${API_BASE}/accounts`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createAccount(
  request: APIRequestContext,
  name: string,
  options: { parentId?: number | null; isPlaceholder?: boolean } = {},
): Promise<TestAccount> {
  const response = await request.post(`${API_BASE}/accounts`, {
    data: {
      name,
      type: "asset",
      parent_id: options.parentId ?? null,
      is_placeholder: options.isPlaceholder ?? false,
      is_overdraft: false,
    },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function selectParent(page: Page, accountName: string, pathPart: string) {
  const select = page.getByLabel(`${accountName} 상위 그룹`);
  const value = await select.locator("option", { hasText: pathPart }).first().getAttribute("value");
  expect(value).not.toBeNull();
  await select.selectOption(value!);
}

test("이름·상위 그룹·마이너스통장을 한 번에 저장하고 되돌릴 수 있다", async ({ page, request }) => {
  await request.post(`${API_BASE}/accounts/seed-standard`);
  const source = await createAccount(request, "설정-E2E-원본그룹");
  const child = await createAccount(request, "설정-E2E-기업은행", { parentId: source.id });
  const target = (await accounts(request)).find((account) => account.name === "입출금통장")!;

  await page.goto("/");
  await nav(page, "계정·개시잔액").click();
  await accountRow(page, child.name).getByRole("button", { name: "설정" }).click();

  await page.getByLabel(`${child.name} 이름`).fill("설정-E2E-기업");
  await selectParent(page, child.name, "자산 / 입출금통장");
  await page.getByLabel(`${child.name} 마이너스통장`).check();
  await page.getByRole("form", { name: `${child.name} 계정 설정` }).getByRole("button", { name: "변경 저장" }).click();

  const movedRow = accountRow(page, "설정-E2E-기업");
  await expect(page.locator(".toast")).toContainText("입출금통장");
  await expect(movedRow).toContainText("마이너스통장");
  await expect(movedRow.getByRole("button", { name: "설정" })).toBeFocused();

  let snapshot = await accounts(request);
  const moved = snapshot.find((account) => account.id === child.id)!;
  expect(moved.name).toBe("설정-E2E-기업");
  expect(moved.parent_id).toBe(target.id);
  expect(moved.is_overdraft).toBe(true);
  expect(moved.position).toBe(Math.max(...snapshot.filter((account) => account.parent_id === target.id).map((account) => account.position)));
  expect(snapshot.find((account) => account.id === source.id)).toMatchObject({ is_placeholder: true });

  await page.reload();
  await nav(page, "계정·개시잔액").click();
  await movedRow.getByRole("button", { name: "설정" }).click();
  await expect(page.getByLabel("설정-E2E-기업 상위 그룹")).toHaveValue(String(target.id));

  await page.getByLabel("설정-E2E-기업 이름").fill(child.name);
  await selectParent(page, "설정-E2E-기업", source.name);
  await page.getByLabel("설정-E2E-기업 마이너스통장").uncheck();
  await page.getByRole("form", { name: "설정-E2E-기업 계정 설정" }).getByRole("button", { name: "변경 저장" }).click();

  snapshot = await accounts(request);
  expect(snapshot.find((account) => account.id === child.id)).toMatchObject({
    name: child.name,
    parent_id: source.id,
    is_overdraft: false,
  });
});

test("중복·stale 오류는 초안을 지키고 저장 중 중복 제출을 막는다", async ({ page, request }) => {
  const parent = await createAccount(request, "설정-E2E-충돌그룹", { isPlaceholder: true });
  const first = await createAccount(request, "설정-E2E-첫계정", { parentId: parent.id });
  const duplicate = await createAccount(request, "설정-E2E-중복계정", { parentId: parent.id });

  await page.goto("/");
  await nav(page, "계정·개시잔액").click();
  await accountRow(page, first.name).getByRole("button", { name: "설정" }).click();
  const firstForm = page.getByRole("form", { name: `${first.name} 계정 설정` });
  const firstName = page.getByLabel(`${first.name} 이름`);
  await firstName.fill(duplicate.name);
  await firstForm.getByRole("button", { name: "변경 저장" }).click();
  await expect(firstForm.getByRole("alert")).toContainText("이미");
  await expect(firstName).toHaveValue(duplicate.name);

  await firstName.press("Escape");
  await expect(accountRow(page, first.name).getByRole("button", { name: "설정" })).toBeFocused();
  await accountRow(page, first.name).getByRole("button", { name: "설정" }).click();
  const draftName = "설정-E2E-사용자초안";
  await page.getByLabel(`${first.name} 이름`).fill(draftName);

  const latest = (await accounts(request)).find((account) => account.id === first.id)!;
  const external = await request.put(`${API_BASE}/accounts/${first.id}/settings`, {
    data: {
      name: "설정-E2E-다른탭최신값",
      parent_id: latest.parent_id,
      is_overdraft: latest.is_overdraft,
      version: latest.version,
    },
  });
  expect(external.ok()).toBe(true);

  const staleForm = page.getByRole("form", { name: `${first.name} 계정 설정` });
  await staleForm.getByRole("button", { name: "변경 저장" }).click();
  await expect(staleForm.getByRole("alert")).toContainText("최신 내용을 확인");
  await expect(page.getByLabel(`${first.name} 이름`)).toHaveValue(draftName);
  expect((await accounts(request)).find((account) => account.id === first.id)?.name).toBe("설정-E2E-다른탭최신값");

  await page.getByLabel(`${first.name} 이름`).press("Escape");
  await page.reload();
  await nav(page, "계정·개시잔액").click();
  const latestName = "설정-E2E-다른탭최신값";
  await accountRow(page, latestName).getByRole("button", { name: "설정" }).click();

  let settingsRequests = 0;
  let releaseRequest = () => {};
  const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const settingsRoute = /\/api\/accounts\/\d+\/settings$/;
  await page.route(settingsRoute, async (route) => {
    if (route.request().method() === "PUT") {
      settingsRequests += 1;
      await requestGate;
    }
    await route.continue();
  });
  const finalName = "설정-E2E-느린저장완료";
  await page.getByLabel(`${latestName} 이름`).fill(finalName);
  const save = page.getByRole("form", { name: `${latestName} 계정 설정` }).locator(".settings-save");
  const requestStarted = page.waitForRequest((request) => (
    request.method() === "PUT" && request.url().endsWith(`/accounts/${first.id}/settings`)
  ));
  await save.click();
  await requestStarted;
  try {
    await expect(save).toBeDisabled();
    await save.evaluate((button: HTMLButtonElement) => button.click());
    expect(settingsRequests).toBe(1);
  } finally {
    releaseRequest();
  }
  await expect(accountRow(page, finalName).getByRole("button", { name: "설정" })).toBeFocused();
  expect(settingsRequests).toBe(1);
  await page.unroute(settingsRoute);

  await accountRow(page, finalName).getByRole("button", { name: "설정" }).click();
  await page.getByLabel(`${finalName} 이름`).fill("설정-E2E-취소할초안");
  await page.getByLabel(`${finalName} 이름`).press("Escape");
  await expect(accountRow(page, finalName).getByRole("button", { name: "설정" })).toBeFocused();
  await expect(page.getByText("설정-E2E-취소할초안")).toHaveCount(0);
});

test("보관 계정은 복원만 제공하고 좁은 화면의 설정 패널은 겹치지 않는다", async ({ page, request }) => {
  const parent = await createAccount(request, "설정-E2E-아주긴상위그룹이름-모바일경로확인", { isPlaceholder: true });
  const child = await createAccount(request, "설정-E2E-모바일대상계정", { parentId: parent.id });
  const duplicate = await createAccount(request, "설정-E2E-모바일중복오류문구확인용계정", { parentId: parent.id });

  await page.goto("/");
  await nav(page, "계정·개시잔액").click();
  await accountRow(page, child.name).getByRole("button", { name: "보관" }).click();
  const archivedRow = page.locator(".archived-ledger tr").filter({ hasText: child.name });
  await expect(archivedRow.getByRole("button", { name: "설정" })).toHaveCount(0);
  await expect(archivedRow.getByRole("button", { name: "복원" })).toBeVisible();
  await archivedRow.getByRole("button", { name: "복원" }).click();
  await expect(accountRow(page, child.name).getByRole("button", { name: "설정" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await accountRow(page, child.name).getByRole("button", { name: "설정" }).click();
  const panel = page.getByRole("form", { name: `${child.name} 계정 설정` });
  const path = panel.locator(".settings-parent-path");
  await expect(path).toContainText(parent.name);
  const panelBox = await panel.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.x).toBeGreaterThanOrEqual(0);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(390);
  expect(await panel.locator("input:not([type=checkbox]), select, button").evaluateAll(
    (elements) => elements.every((element) => element.getBoundingClientRect().height >= 44),
  )).toBe(true);
  expect(await panel.locator(".settings-overdraft").evaluate(
    (element) => element.getBoundingClientRect().height >= 44,
  )).toBe(true);

  await page.getByLabel(`${child.name} 이름`).fill(duplicate.name);
  await panel.getByRole("button", { name: "변경 저장" }).click();
  const error = panel.getByRole("alert");
  await expect(error).toContainText("이미");
  const errorBox = await error.boundingBox();
  expect(errorBox).not.toBeNull();
  expect(errorBox!.x + errorBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
});

test("설정 저장 후 계정 갱신 실패는 기존 행과 재시도 경로를 함께 유지한다", async ({ page, request }) => {
  const account = await createAccount(request, "설정-E2E-갱신전이름");
  let failAccountReads = false;
  await page.route("**/api/accounts", async (route) => {
    if (failAccountReads && route.request().method() === "GET") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "계정 갱신 임시 실패" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await nav(page, "계정·개시잔액").click();
  await accountRow(page, account.name).getByRole("button", { name: "설정" }).click();

  const renamed = "설정-E2E-갱신후이름";
  await page.getByLabel(`${account.name} 이름`).fill(renamed);
  failAccountReads = true;
  await page.getByRole("form", { name: `${account.name} 계정 설정` })
    .getByRole("button", { name: "변경 저장" }).click();

  const refreshError = page.getByRole("alert").filter({ hasText: "계정을 불러오지 못했습니다" });
  await expect(refreshError).toBeVisible();
  await expect(accountRow(page, account.name)).toBeVisible();
  await expect(accountRow(page, renamed)).toHaveCount(0);

  failAccountReads = false;
  await refreshError.getByRole("button", { name: "다시 시도" }).click();
  await expect(accountRow(page, renamed)).toBeVisible();
  await expect(refreshError).toBeHidden();
});
