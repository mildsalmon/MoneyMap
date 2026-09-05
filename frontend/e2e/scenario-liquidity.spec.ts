import { expect, test, type APIRequestContext } from "./test";
import AxeBuilder from "@axe-core/playwright";

const API = (process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? "8765"}/api`).replace(/\/+$/, "");
async function create(request: APIRequestContext) {
  const result = await request.post(`${API}/scenarios`, { data: { name: "현금 전망 검증", fork_date: "2026-01-31" } });
  expect(result.ok()).toBeTruthy();
  return (await result.json()).scenario;
}

test("현금 계정 설정·충돌 초안·취소·저장 및 미설정 안내", async ({ page, request }) => {
  const group = await (await request.post(`${API}/accounts`, { data: { name: "현금설정 검증그룹", type: "asset", is_placeholder: true } })).json();
  const bank = await (await request.post(`${API}/accounts`, { data: { name: "현금설정 검증은행", type: "asset", parent_id: group.id } })).json();
  const scenario = await create(request);
  // The suite shares a database: explicitly clear selections for this empty-state case.
  for (const account of await (await request.get(`${API}/accounts`)).json()) {
    if (account.include_in_cash) {
      const cleared = await request.put(`${API}/accounts/${account.id}/settings`, { data: { ...account, include_in_cash: false } });
      expect(cleared.ok()).toBeTruthy();
    }
  }
  await page.goto(`/scenarios/${scenario.id}`);
  await page.getByRole("button", { name: "현금성 잔액", exact: true }).click();
  await expect(page.getByText("현금 부족 계산에 포함할 계정을 먼저 선택하세요", { exact: false })).toBeVisible();
  await expect(page.getByLabel("현금성 잔액 프로젝션 차트", { exact: false })).toHaveCount(0);
  await page.getByRole("link", { name: "계정 설정", exact: true }).click();
  const groupRow = page.locator("tr.account-row").filter({ hasText: group.name });
  await expect(groupRow).toContainText("하위 1개 중 0개 포함");
  const row = page.locator("tr.account-row").filter({ hasText: bank.name });
  await row.getByRole("button", { name: "설정", exact: true }).click();
  const form = page.getByRole("form", { name: `${bank.name} 계정 설정` });
  const checkbox = form.getByRole("checkbox", { name: "현금 부족 계산에 포함", exact: false });
  await checkbox.check();
  await form.getByRole("button", { name: "취소", exact: true }).click();
  await expect(row.getByRole("button", { name: "설정", exact: true })).toBeFocused();
  await row.getByRole("button", { name: "설정", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.route(`**/accounts/${bank.id}/settings`, (route) => route.fulfill({ status: 409, json: { detail: "다른 화면에서 계정이 변경되었습니다", code: "account_settings_stale" } }));
  await form.getByRole("button", { name: "변경 저장" }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(checkbox).toBeChecked();
  await page.unroute(`**/accounts/${bank.id}/settings`);
  await form.getByRole("button", { name: "변경 저장" }).click();
  await expect(form).toHaveCount(0);
  await expect(row).toContainText("현금성");
  await expect(groupRow).toContainText("하위 1개 중 1개 포함");
  await groupRow.getByRole("button", { name: "설정", exact: true }).click();
  const groupForm = page.getByRole("form", { name: `${group.name} 계정 설정` });
  await expect(groupForm.getByRole("checkbox", { name: "현금 부족 계산에 포함", exact: false })).toHaveCount(0);
  await groupForm.getByRole("button", { name: "취소", exact: true }).click();
  await page.goto(`/scenarios/${scenario.id}`);
  await page.getByRole("button", { name: "현금성 잔액", exact: true }).click();
  await expect(page.getByLabel("현금성 잔액 프로젝션 차트", { exact: false })).toBeVisible();
});

test("현금 부족 골든·720px·키보드·접근성 및 capability 호환", async ({ page, request }) => {
  const scenario = await create(request);
  let capable = true;
  await page.route("**/projection?**", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.capabilities = { scenario_liquidity: capable };
    data.has_assumptions = true;
    data.cash = { available: true,
      baseline: { points: [{ date: "2026-01-31", balance: 100 }, { date: "2026-07-31", balance: 100 }], shortage: null },
      scenario: { points: [{ date: "2026-01-31", balance: 100 }, { date: "2026-02-02", balance: -40 }, { date: "2026-02-05", balance: 0 }, { date: "2026-07-31", balance: 0 }],
        shortage: { first_shortage: { start: "2026-02-02", end: "2026-02-04", days: 3, through_horizon: false,
          triggering_items: [{ kind: "rule", id: 1, label: "월세" }, { kind: "planned_transaction", id: 2, label: "이사 보증금" }] },
          maximum_shortage: { date: "2026-02-02", balance: -40 } } } };
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(`/scenarios/${scenario.id}`);
  await expect(page.getByRole("heading", { name: "순자산 전망" })).toBeVisible();
  const cash = page.getByRole("button", { name: "현금성 잔액", exact: true });
  await cash.focus();
  await page.keyboard.press("Enter");
  await expect(cash).toHaveAttribute("aria-pressed", "true");
  const shortage = page.getByRole("region", { name: `${scenario.name} 현금 부족`, exact: true });
  await expect(shortage).toContainText("2026-02-02 ~ 2026-02-04 (3일)");
  await expect(shortage).toContainText("최대 부족: ₩40");
  const maximumAmount = shortage.locator(".shortage-maximum .num");
  await expect(maximumAmount).toHaveText("₩40");
  await expect(maximumAmount).toHaveCSS("text-align", "right");
  await expect(maximumAmount).toHaveCSS("font-variant-numeric", /tabular-nums/);
  await expect(shortage.getByRole("listitem")).toHaveText(["월세", "이사 보증금"]);
  const chart = page.getByLabel("현금성 잔액 프로젝션 차트", { exact: false });
  await chart.focus();
  await page.keyboard.press("ArrowRight");
  await expect(chart).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  capable = false;
  await page.reload();
  // Heading renders before the projection response: wait for loaded data before teardown.
  await expect(page.locator(".scenario-summary")).toBeVisible();
  await expect(page.getByRole("heading", { name: "순자산 전망" })).toBeVisible();
  await expect(cash).toHaveCount(0);
});

test("현금 조회 실패 재시도와 음수 시작·기간 내 미회복 안내", async ({ page, request }) => {
  const scenario = await create(request);
  let fail = false;
  await page.route("**/projection?**", async (route) => {
    if (fail) return route.fulfill({ status: 503, json: { detail: "계산을 다시 시도하세요" } });
    const response = await route.fetch();
    const data = await response.json();
    const curve = { points: [{ date: data.fork_date, balance: -10 }, { date: data.projection_end, balance: -10 }],
      shortage: { first_shortage: { start: data.fork_date, end: null, days: 90, through_horizon: true,
        reason: "negative_start_balance", triggering_items: [] }, maximum_shortage: { date: data.fork_date, balance: -10 } } };
    data.cash = { available: true, baseline: curve, scenario: curve };
    await route.fulfill({ response, json: data });
  });
  await page.goto(`/scenarios/${scenario.id}`);
  await page.getByRole("button", { name: "현금성 잔액", exact: true }).click();
  fail = true;
  await page.getByRole("button", { name: "3개월", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("계산을 다시 시도하세요");
  fail = false;
  await page.getByRole("button", { name: "다시 계산", exact: true }).click();
  await expect(page.getByRole("heading", { name: "현금성 잔액 전망" })).toBeVisible();
  const shortage = page.getByRole("region", { name: `${scenario.name} 현금 부족`, exact: true });
  await expect(shortage).toContainText("전망 종료일까지 지속");
  await expect(shortage).toContainText("시작 기준일 잔액이 이미 음수입니다.");
});

test("실제 API 예정 이체는 순자산을 유지하고 선택 계정의 현금 부족을 만든다", async ({ page, request }) => {
  const bank = await (await request.post(`${API}/accounts`, { data: { name: "현금골든 입출금", type: "asset" } })).json();
  const deposit = await (await request.post(`${API}/accounts`, { data: { name: "현금골든 보증금", type: "asset" } })).json();
  const selected = await request.put(`${API}/accounts/${bank.id}/settings`, { data: { ...bank, include_in_cash: true } });
  expect(selected.ok()).toBeTruthy();
  const opening = await request.post(`${API}/accounts/${bank.id}/opening-balance`, {
    data: { date: "2026-01-31", amount: 100, state: "positive" },
  });
  expect(opening.ok()).toBeTruthy();
  const openingId = (await opening.json()).id;
  try {
  const scenario = await create(request);
  const planned = await request.post(`${API}/scenarios/${scenario.id}/planned-transactions`, { data: {
    date: "2026-02-02", description: "보증금 예정 이체", scenario_version: scenario.version,
    postings: [{ account_id: bank.id, amount: -200 }, { account_id: deposit.id, amount: 200 }],
  } });
  expect(planned.ok()).toBeTruthy();
  await page.goto(`/scenarios/${scenario.id}`);
  await expect(page.locator(".scenario-summary")).toContainText("₩0");
  await page.getByRole("button", { name: "현금성 잔액", exact: true }).click();
  const shortage = page.getByRole("region", { name: `${scenario.name} 현금 부족`, exact: true });
  await expect(shortage).toContainText("2026-02-02");
  await expect(shortage).toContainText("최대 부족: ₩100");
  await expect(shortage).toContainText("보증금 예정 이체");
  } finally {
    const removed = await request.delete(`${API}/transactions/${openingId}`);
    expect(removed.ok()).toBeTruthy();
  }
});
