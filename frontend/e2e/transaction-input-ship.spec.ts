import { expect, test, type Page, type Route } from "./test";

const accounts = [
  { id: 101, name: "식비", type: "expense" },
  { id: 102, name: "현금", type: "asset" },
].map((account, position) => ({ parent_id: null, currency: "KRW", archived: false, is_placeholder: false, is_system: false, is_overdraft: false, version: 1, position, ...account }));
const item = (page: Page) => page.getByLabel("아이템 (선택)", { exact: true });
const memo = (page: Page) => page.getByLabel("메모 (선택)", { exact: true });
const amount = (page: Page) => page.getByLabel("금액", { exact: true });
const save = (page: Page) => page.getByRole("button", { name: "저장 (Enter)", exact: true });
const dashboardSave = (page: Page) => page.getByRole("button", { name: "저장 후 대시보드", exact: true });
const recent = { id: 700, date: "2026-09-05", description: "이전 거래", amount: 123, posting_count: 2, debit_account_id: 101, credit_account_id: 102 };

test.beforeEach(async ({ page }) => {
  await page.route("**/api/accounts", route => route.fulfill({ json: accounts }));
  await page.route("**/api/status", route => route.fulfill({ json: { trial_balance_ok: true, last_backup: "2026-09-05", last_entry: null } }));
  await page.route("**/api/materialize", route => route.fulfill({ json: { created: 0, transactions: [] } }));
  await page.route("**/api/transaction-input/recent?*", route => route.fulfill({ json: [] }));
  await page.route("**/api/transaction-input/last-pair?*", route => route.fulfill({ json: {
    item_key: new URL(route.request().url()).searchParams.get("item"), status: "none", source_transaction_id: null,
    debit_account_id: null, credit_account_id: null, unavailable_reason: null,
  } }));
  await page.goto("/transactions/new");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
});

async function fillDraft(page: Page, description = "이전 거래", value = "123", note = "제출 메모") {
  await item(page).fill(description);
  await page.getByRole("group", { name: "차변 계정", exact: true }).getByRole("radio", { name: "비용 > 식비", exact: true }).check();
  await page.getByRole("group", { name: "대변 계정", exact: true }).getByRole("radio", { name: "자산 > 현금", exact: true }).check();
  await amount(page).fill(value);
  await memo(page).fill(note);
  await expect(save(page)).toBeEnabled();
}

for (const editMemo of [false, true]) {
  test(`save-and-dashboard ${editMemo ? "preserves a newer memo and focus" : "navigates after the unchanged submission succeeds"}`, async ({ page }) => {
    let held: Route | undefined;
    await page.route("**/api/transactions", route => route.request().method() === "POST" ? (held = route, undefined) : route.continue());
    await fillDraft(page);
    await dashboardSave(page).click();
    await expect.poll(() => !!held).toBe(true);
    await expect(page).toHaveURL(/\/transactions\/new$/);
    if (editMemo) await memo(page).fill("次の 거래 메모\n새 초안");
    expect(held!.request().postDataJSON()).toMatchObject({ description: "이전 거래", memo: "제출 메모", postings: [{ account_id: 101, amount: 123 }, { account_id: 102, amount: -123 }] });
    await held!.fulfill({ status: 201, json: { id: 700 } });
    await expect(page.locator(".toast")).toContainText("이전 거래 · ₩123 저장됨");
    if (editMemo) {
      await expect(page).toHaveURL(/\/transactions\/new$/);
      await expect(memo(page)).toHaveValue("次の 거래 메모\n새 초안");
      await expect(memo(page)).toBeFocused();
      await expect(amount(page)).toHaveValue("123");
      await expect(save(page)).toBeEnabled();
    } else {
      await expect(page).toHaveURL(new URL("/", page.url()).href);
      await expect(page.locator(".txn-page")).toHaveCount(0);
    }
  });
}

test("an old save completing after remount refreshes recent inputs without replacing the new draft", async ({ page }) => {
  let held: Route | undefined;
  let completed = false;
  await page.route("**/api/transactions", route => route.request().method() === "POST" ? (held = route, undefined) : route.fulfill({ json: [] }));
  await page.route("**/api/transaction-input/recent?*", route => route.fulfill({ json: completed ? [recent] : [] }));
  await fillDraft(page);
  await dashboardSave(page).click();
  await expect.poll(() => !!held).toBe(true);
  await page.locator(".side nav").getByRole("button", { name: "거래 내역", exact: true }).click();
  await expect(page).toHaveURL(/\/transactions$/);
  await page.locator(".side nav").getByRole("button", { name: "거래 입력", exact: true }).click();
  await expect(memo(page)).toHaveValue("");
  await fillDraft(page, "새 거래", "456", "재진입 후 작성한 메모");
  await expect(page.locator(".txn-recent")).toContainText("저장한 거래가 여기에 표시됩니다.");
  completed = true;
  await held!.fulfill({ status: 201, json: { id: 700 } });
  await expect(page.locator(".txn-recent").getByRole("button", { name: "이전 거래", exact: true })).toBeVisible();
  await expect(page.locator(".toast")).toContainText("이전 거래 · ₩123 저장됨");
  await expect(page).toHaveURL(/\/transactions\/new$/);
  await expect(item(page)).toHaveValue("새 거래");
  await expect(amount(page)).toHaveValue("456");
  await expect(memo(page)).toHaveValue("재진입 후 작성한 메모");
  await expect(memo(page)).toBeFocused();
  await expect(save(page)).toBeEnabled();
});

test("an identical save in flight is shared across route remounts and a later save remains intentional", async ({ page }) => {
  let held: Route | undefined;
  let posts = 0;
  await page.route("**/api/transactions", route => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    if (posts === 1) held = route;
    else return route.fulfill({ status: 201, json: { id: 701 } });
  });
  await fillDraft(page);
  await dashboardSave(page).click();
  await expect.poll(() => !!held).toBe(true);

  await page.locator(".side nav").getByRole("button", { name: "거래 내역", exact: true }).click();
  await page.locator(".side nav").getByRole("button", { name: "거래 입력", exact: true }).click();
  await fillDraft(page);
  const unexpectedDuplicate = page.waitForRequest(
    request => request.method() === "POST" && new URL(request.url()).pathname === "/api/transactions",
    { timeout: 750 },
  ).then(() => true, () => false);
  await save(page).click();
  await expect(page.locator(".txn-savebar button[type=submit]")).toHaveText("저장 중…");
  expect(await unexpectedDuplicate).toBe(false);
  expect(posts).toBe(1);

  await held!.fulfill({ status: 201, json: { id: 700 } });
  await expect(page.locator(".toast")).toContainText("이전 거래 · ₩123 저장됨");
  await expect(amount(page)).toHaveValue("");

  await item(page).fill("새 의도");
  await fillDraft(page);
  const laterRequest = page.waitForRequest(
    request => request.method() === "POST" && new URL(request.url()).pathname === "/api/transactions",
  );
  await save(page).click();
  expect((await laterRequest).postDataJSON()).toMatchObject({
    description: "이전 거래",
    memo: "제출 메모",
    postings: [{ account_id: 101, amount: 123 }, { account_id: 102, amount: -123 }],
  });
  await expect.poll(() => posts).toBe(2);
  await expect(amount(page)).toHaveValue("");
});

test("a late failed save identifies the submission and preserves newer amount, memo, and focus", async ({ page }) => {
  let held: Route | undefined;
  let posts = 0;
  await page.route("**/api/transactions", route => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    held = route;
  });
  await fillDraft(page);
  await dashboardSave(page).click();
  await expect.poll(() => !!held).toBe(true);
  await item(page).fill("다음 거래");
  await amount(page).fill("456");
  await memo(page).fill("응답 전에 고친 메모\n둘째 줄");
  expect(held!.request().postDataJSON()).toMatchObject({ description: "이전 거래", memo: "제출 메모", postings: [{ account_id: 101, amount: 123 }, { account_id: 102, amount: -123 }] });
  await held!.abort("failed");
  await expect(page.getByRole("alert")).toContainText("이전 거래: 저장 결과를 확인하지 못했습니다. 거래 내역을 확인해 주세요.");
  await expect(page).toHaveURL(/\/transactions\/new$/);
  await expect(item(page)).toHaveValue("다음 거래");
  await expect(amount(page)).toHaveValue("456");
  await expect(memo(page)).toHaveValue("응답 전에 고친 메모\n둘째 줄");
  await expect(memo(page)).toBeFocused();
  await expect(save(page)).toBeEnabled();
  await expect(page.locator(".toast")).toHaveCount(0);
  expect(posts).toBe(1);
});

test("recent-input failure and retry preserve a valid manual draft", async ({ page }) => {
  let retrySucceeds = false;
  await page.route("**/api/transaction-input/recent?*", route => retrySucceeds
    ? route.fulfill({ json: [recent] })
    : route.fulfill({ status: 503, json: { detail: "최근 입력 조회 실패" } }));
  await page.reload();
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  const alert = page.locator(".txn-recent").getByRole("alert");
  await expect(alert).toContainText("최근 입력을 불러오지 못했습니다.");
  await fillDraft(page, "새 거래", "456", "목록 오류 중에도 유지");
  retrySucceeds = true;
  await alert.getByRole("button", { name: "최근 입력 다시 불러오기", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator(".txn-recent").getByRole("button", { name: "이전 거래", exact: true })).toBeVisible();
  await expect(item(page)).toHaveValue("새 거래");
  await expect(amount(page)).toHaveValue("456");
  await expect(memo(page)).toHaveValue("목록 오류 중에도 유지");
  await expect(save(page)).toBeEnabled();
  let submitted: unknown;
  await page.route("**/api/transactions", route => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: 701 } });
  });
  await save(page).click();
  await expect(page.locator(".toast")).toContainText("새 거래 · ₩456 저장됨");
  expect(submitted).toMatchObject({ description: "새 거래", memo: "목록 오류 중에도 유지", postings: [{ account_id: 101, amount: 456 }, { account_id: 102, amount: -456 }] });
});
