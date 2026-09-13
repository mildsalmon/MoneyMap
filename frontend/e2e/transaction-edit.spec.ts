import { expect, test, type Page, type Route, type APIRequestContext } from "./test";
import AxeBuilder from "@axe-core/playwright";
import { applied, editAccounts, makeDetail } from "./transactionEditFixtures";
import type { TransactionDetail, TransactionEditBody } from "../src/api/types";

const base = process.env.MONEYMAP_E2E_API_BASE ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;
const item = (page: Page) => page.getByLabel("아이템 (선택)", { exact: true });
const memo = (page: Page) => page.getByLabel("메모 (선택)", { exact: true });
const amount = (page: Page) => page.getByLabel("금액", { exact: true });
const save = (page: Page) => page.getByRole("button", { name: "변경사항 저장", exact: true });
const cancel = (page: Page) => page.getByRole("button", { name: "취소하고 거래 내역으로", exact: true });
const historyTxn = (detail: TransactionDetail) => ({ ...detail, postings: detail.postings.map(p => ({ account_id: p.account_id, amount: { amount: p.amount, currency: p.currency } })) });

async function mockEditor(page: Page, original = makeDetail(), goto = true) {
  await page.route("**/api/accounts", r => r.fulfill({ json: editAccounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: ["데이트", "엄마"] }));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: [historyTxn(original)] }));
  await page.route(`**/api/transactions/${original.id}`, r => r.request().method() === "GET"
    ? r.fulfill({ json: original }) : r.fulfill({ json: applied(original, r.request().postDataJSON()) }));
  if (goto) {
    await page.goto(`/transactions/${original.id}/edit`);
    await expect(item(page)).toHaveValue(original.description);
    await expect(page.locator(".side .health")).not.toContainText("상태 확인 중…");
  }
}
async function account(request: APIRequestContext, type = "asset") {
  const name = `수정검증-${type}-${crypto.randomUUID()}`;
  const result = await request.post(`${base}/accounts`, { data: { name, type } });
  expect(result.ok()).toBeTruthy(); return result.json();
}
async function realTransaction(request: APIRequestContext) {
  const expense = await account(request, "expense"), cash = await account(request), other = await account(request);
  const result = await request.post(`${base}/transactions`, { data: { date: "2026-01-02", description: `실제 수정 ${cash.id}`, memo: "이전 메모", tags: [`편집-${cash.id}`],
    postings: [{ account_id: expense.id, amount: 100 }, { account_id: cash.id, amount: -100 }] } });
  expect(result.ok()).toBeTruthy();
  return { txn: await result.json(), expense, cash, other };
}

test("real edit saves every field without replacing transaction, restores filter and refreshes both balances", async ({ page, request }) => {
  const { txn, expense, cash, other } = await realTransaction(request);
  const original = await (await request.get(`${base}/transactions/${txn.id}`)).json();
  try {
    await page.goto(`/transactions?tag=${encodeURIComponent(txn.tags[0])}`);
    await page.getByRole("row").filter({ hasText: txn.description }).getByRole("button", { name: "수정", exact: true }).click();
    await expect(item(page)).toHaveValue(txn.description);
    await page.getByLabel("날짜", { exact: true }).fill("2026-02-03");
    await item(page).fill("수정된 내역"); await memo(page).fill("첫 줄\n<strong>그대로</strong> ☕"); await amount(page).fill("250");
    const credit = page.getByRole("group", { name: "대변 계정", exact: true });
    await credit.getByLabel("대변 계정 검색").fill(other.name); await credit.getByRole("radio").check();
    await page.getByRole("button", { name: `${txn.tags[0]} 태그 제거`, exact: true }).click();
    await page.getByLabel("태그 (선택·여러 개)", { exact: true }).fill("새 태그");
    await page.getByRole("button", { name: "추가", exact: true }).click();
    await save(page).click();
    await expect(page).toHaveURL(new RegExp(`/transactions\\?tag=${encodeURIComponent(txn.tags[0])}$`));
    await expect(page.getByText("저장했습니다. 변경된 태그가 현재 필터와 달라 목록에 표시되지 않습니다.")).toBeVisible();
    await expect(page.getByLabel("태그", { exact: true })).toHaveValue(txn.tags[0]);
    await expect(page.getByRole("heading", { name: "거래 내역", exact: true })).toBeFocused();
    const saved = await (await request.get(`${base}/transactions/${txn.id}`)).json();
    expect(saved).toMatchObject({ id: txn.id, date: "2026-02-03", description: "수정된 내역", memo: "첫 줄\n<strong>그대로</strong> ☕", tags: ["새 태그"], entry_origin: original.entry_origin });
    expect(saved.postings.map((p: any) => p.posting_id)).toEqual(original.postings.map((p: any) => p.posting_id));
    expect(saved.postings.map((p: any) => [p.account_id, p.amount])).toEqual([[expense.id, 250], [other.id, -250]]);
    const balances = (await (await request.get(`${base}/balances`)).json()).accounts;
    expect(balances.find((a: any) => a.account_id === cash.id).balance).toBe(0);
    expect(balances.find((a: any) => a.account_id === other.id).balance).toBe(-250);
  } finally { await request.delete(`${base}/transactions/${txn.id}`); }
});

test("real basic-to-split edit persists an added row and reloads losslessly", async ({ page, request }) => {
  const { txn, other } = await realTransaction(request);
  try {
    await page.goto(`/transactions/${txn.id}/edit`); await expect(save(page)).toBeEnabled();
    await page.getByRole("button", { name: "분할 입력", exact: true }).click();
    await page.getByLabel("1행 금액", { exact: true }).fill("60");
    await page.getByRole("button", { name: "+ 행 추가", exact: true }).click();
    await page.getByRole("button", { name: /3행 계정/ }).click();
    const picker = page.getByRole("group", { name: "3행 계정", exact: true });
    await picker.getByLabel("3행 계정 검색").fill(other.name); await picker.getByRole("radio").click();
    await expect(page.getByRole("button", { name: /3행 계정/ })).toContainText(other.name);
    await page.getByLabel("3행 금액", { exact: true }).fill("40");
    await save(page).click(); await expect(page).toHaveURL(/\/transactions$/);
    await page.goto(`/transactions/${txn.id}/edit`);
    await expect(page.getByLabel("3행 금액", { exact: true })).toHaveValue("40");
    expect((await (await request.get(`${base}/transactions/${txn.id}`)).json()).postings).toHaveLength(3);
  } finally { await request.delete(`${base}/transactions/${txn.id}`); }
});

test("real opening edit fixes the system counterpart and keeps one transaction", async ({ page, request }) => {
  const target = await account(request);
  const created = await request.post(`${base}/accounts/${target.id}/opening-balance`, { data: { date: "2026-01-01", amount: 100, state: "positive" } });
  expect(created.ok()).toBeTruthy(); const txn = await created.json();
  try {
    await page.goto(`/transactions/${txn.id}/edit`); await expect(save(page)).toBeEnabled();
    await expect(page.getByText("개시잔액 시스템 상대계정 · 금액은 자동 계산됩니다.")).toBeVisible();
    await expect(page.getByRole("button", { name: "분할 입력", exact: true })).toHaveCount(0);
    await amount(page).fill("200"); await memo(page).fill("잔액 수정"); await save(page).click();
    await expect(page).toHaveURL(/\/transactions$/);
    const saved = await (await request.get(`${base}/transactions/${txn.id}`)).json();
    expect(saved.kind).toBe("opening"); expect(saved.postings.map((p: any) => p.amount).sort((a: number, b: number) => a - b)).toEqual([-200, 200]);
  } finally { await request.delete(`${base}/transactions/${txn.id}`); }
});

test("real generated transaction changes only this occurrence, not its rule or watermark", async ({ page, request }) => {
  const source = await account(request), target = await account(request, "expense");
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
  const created = await request.post(`${base}/rules`, { data: { description: "반복 수정 검증", from_account_id: source.id, to_account_id: target.id,
    amount: 100, schedule: `monthly:${Number(today.slice(8))}`, start_date: today, end_date: today } });
  expect(created.ok()).toBeTruthy(); const rule = await created.json();
  try {
    await request.post(`${base}/materialize`);
    const generated = (await (await request.get(`${base}/transactions`)).json()).find((t: any) => t.source_rule_id === rule.id);
    expect(generated).toBeTruthy();
    const rulesBefore = await (await request.get(`${base}/rules`)).json();
    await page.goto(`/transactions/${generated.id}/edit`); await expect(save(page)).toBeEnabled();
    await expect(page.getByText("이 거래 한 건만 변경되며 반복 규칙과 다음 거래는 바뀌지 않습니다.")).toBeVisible();
    await amount(page).fill("125"); await memo(page).fill("이번 회차만 변경"); await save(page).click();
    await expect(page).toHaveURL(/\/transactions$/);
    const saved = await (await request.get(`${base}/transactions/${generated.id}`)).json();
    expect(saved).toMatchObject({ id: generated.id, source_rule_id: rule.id, entry_origin: "rule", memo: "이번 회차만 변경" });
    expect(await (await request.get(`${base}/rules`)).json()).toEqual(rulesBefore);
    expect((await (await request.post(`${base}/materialize`)).json()).created).toBe(0);
  } finally {
    const transactions = await (await request.get(`${base}/transactions`)).json();
    for (const txn of transactions.filter((t: any) => t.source_rule_id === rule.id)) await request.delete(`${base}/transactions/${txn.id}`);
    await request.delete(`${base}/rules/${rule.id}`);
  }
});

test("beforeunload guard exists only for changed user data, and reverting a field removes it", async ({ page }) => {
  await mockEditor(page);
  const prevented = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
  });
  expect(await prevented()).toBe(false);
  await memo(page).fill("변경된 내용"); await expect.poll(prevented).toBe(true);
  await memo(page).fill(makeDetail().memo); await expect.poll(prevented).toBe(false);
});

test("failed latest-transaction lookup preserves conflict draft and permits another read", async ({ page }) => {
  await mockEditor(page); let fails = true;
  await page.route("**/api/transactions/71", r => r.request().method() === "PUT"
    ? r.fulfill({ status: 409, json: { detail: "변경 충돌" } })
    : fails ? r.fulfill({ status: 500, json: { detail: "조회 실패" } }) : r.fulfill({ json: makeDetail({ memo: "서버 최신값", version: "c".repeat(32) }) }));
  await memo(page).fill("내 작성 내용"); await save(page).click();
  const latest = page.getByRole("button", { name: "최신 거래 확인", exact: true }); await latest.click();
  await expect(page.getByText("최신 거래를 불러오지 못했습니다. 작성 내용은 유지했습니다.")).toBeVisible();
  await expect(memo(page)).toHaveValue("내 작성 내용"); await expect(save(page)).toBeDisabled();
  fails = false; await latest.click(); await expect(page.getByText("서버 최신값", { exact: true })).toBeVisible();
});

test("imported fields and archived zero rows hydrate without recall or identity loss", async ({ page }) => {
  const original = makeDetail({ entry_origin: "legacy", postings: [
    { posting_id: 11, account_id: 106, amount: 0, currency: "KRW" }, { posting_id: 12, account_id: 102, amount: 0, currency: "KRW" }] });
  let recalls = 0, submitted: TransactionEditBody | undefined;
  await page.route("**/api/transaction-input/last-pair?*", r => { recalls++; return r.abort(); });
  await mockEditor(page, original);
  await page.route("**/api/transactions/71", r => { submitted = r.request().postDataJSON(); return r.fulfill({ json: applied(original, submitted!) }); });
  await item(page).fill("내역만 고침"); await memo(page).fill("메모만 수정"); await save(page).click();
  await expect(page).toHaveURL(/\/transactions$/);
  expect(recalls).toBe(0); expect(submitted?.postings).toEqual(original.postings.map(({ currency, ...p }) => p));
});

for (const failure of [400, 413, 422, 503]) {
  test(`known save failure ${failure} preserves fields and permits deliberate retry`, async ({ page }) => {
    await mockEditor(page); let puts = 0, resolves = 0;
    await page.route("**/api/transactions/71/edit-result", r => { resolves++; return r.abort(); });
    await page.route("**/api/transactions/71", r => { puts++; return r.fulfill({ status: failure, json: { detail: { code: failure === 503 ? "database_busy" : "invalid", message: "저장하지 못했습니다" } } }); });
    await memo(page).fill("유지할 초안"); await save(page).click();
    await expect(page.getByText("저장하지 못했습니다", { exact: true })).toBeVisible();
    await expect(memo(page)).toHaveValue("유지할 초안"); await expect(save(page)).toBeEnabled(); expect(puts).toBe(1); expect(resolves).toBe(0);
  });
}

for (const deleted of [false, true]) {
  test(`stale edit preserves draft and explicitly reviews latest ${deleted ? "deleted" : "modified"} transaction`, async ({ page }) => {
    await mockEditor(page);
    await page.route("**/api/transactions/71", r => r.request().method() === "PUT"
      ? r.fulfill({ status: deleted ? 404 : 409, json: { detail: "다른 변경이 있습니다" } })
      : deleted ? r.fulfill({ status: 404, json: { detail: "없음" } }) : r.fulfill({ json: makeDetail({ version: "c".repeat(32), memo: "다른 창 변경" }) }));
    await memo(page).fill("내 초안"); await save(page).click(); await expect(save(page)).toBeDisabled();
    await expect(memo(page)).toHaveValue("내 초안");
    await page.getByRole("button", { name: "최신 거래 확인", exact: true }).click();
    if (deleted) await expect(page.getByText("거래가 삭제되었습니다. 다시 생성하지 않습니다.")).toBeVisible();
    else {
      await expect(page.getByText("다른 창 변경", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "최신 값으로 다시 수정", exact: true }).click();
      await expect(memo(page)).toHaveValue("다른 창 변경"); await expect(save(page)).toBeEnabled();
      await page.getByText("저장하지 못한 작성 내용", { exact: true }).click();
      await expect(page.locator(".edit-draft-summary")).toContainText("내 초안");
    }
  });
}

for (const response of ["lost", "malformed", "not_applied"] as const) {
  test(`real result resolution handles ${response} without replaying the write`, async ({ page, request }) => {
    const { txn } = await realTransaction(request); let puts = 0, resolves = 0;
    try {
      await page.goto(`/transactions/${txn.id}/edit`); await expect(save(page)).toBeEnabled();
      await page.route(`**/api/transactions/${txn.id}`, async r => {
        if (r.request().method() !== "PUT") return r.continue();
        puts++; if (response !== "not_applied") expect((await r.fetch()).ok()).toBeTruthy();
        return response === "malformed" ? r.fulfill({ json: { outcome: "applied" } }) : r.abort("failed");
      });
      await page.route(`**/api/transactions/${txn.id}/edit-result`, r => { resolves++; return r.continue(); });
      await memo(page).fill("응답 복구"); await save(page).click();
      if (response === "not_applied") {
        await expect(page.getByText("저장되지 않은 것을 확인했습니다. 작성 내용을 확인하고 다시 저장하세요.")).toBeVisible();
        await expect(memo(page)).toHaveValue("응답 복구"); await expect(save(page)).toBeEnabled();
      } else {
        await expect(page).toHaveURL(/\/transactions$/);
        expect((await (await request.get(`${base}/transactions/${txn.id}`)).json()).memo).toBe("응답 복구");
      }
      expect(puts).toBe(1); expect(resolves).toBe(1);
    } finally { await request.delete(`${base}/transactions/${txn.id}`); }
  });
}

test("unknown resolver locks draft, result retry uses same ID, next explicit save uses a new ID", async ({ page }) => {
  const original = makeDetail(); await mockEditor(page, original);
  const submits: TransactionEditBody[] = [], checks: TransactionEditBody[] = [];
  await page.route("**/api/transactions/71", r => { submits.push(r.request().postDataJSON()); return r.abort(); });
  await page.route("**/api/transactions/71/edit-result", r => {
    checks.push(r.request().postDataJSON());
    return checks.length === 1 ? r.abort() : r.fulfill({ json: { request_id: checks.at(-1)!.request_id, outcome: "not_applied", result_version: null, transaction: original } });
  });
  await memo(page).fill("초안 유지"); await save(page).click();
  await expect(page.getByRole("button", { name: "저장 결과 다시 확인", exact: true })).toBeEnabled();
  await expect(memo(page)).toBeDisabled(); await expect(save(page)).toBeDisabled();
  await page.getByRole("button", { name: "저장 결과 다시 확인", exact: true }).click();
  await expect(save(page)).toBeEnabled(); expect(checks[0].request_id).toBe(checks[1].request_id);
  await save(page).click(); await expect.poll(() => submits.length).toBe(2);
  expect(submits[0].request_id).not.toBe(submits[1].request_id);
});

test("pending save blocks duplicate Enter, confirms exit, and late response cannot navigate away from new screen", async ({ page }) => {
  const original = makeDetail(); await mockEditor(page, original); let held: Route | undefined, puts = 0;
  await page.route("**/api/transactions/71", r => { puts++; held = r; });
  await memo(page).fill("저장 중"); await save(page).click(); await expect.poll(() => puts).toBe(1);
  await page.locator("form").dispatchEvent("submit"); expect(puts).toBe(1); await expect(memo(page)).toBeDisabled();
  page.once("dialog", d => d.accept()); await page.locator("nav").getByRole("button", { name: "계정·개시잔액", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await held!.fulfill({ json: applied(original, held!.request().postDataJSON()) });
  await expect(page).toHaveURL(/\/accounts$/); await expect(page.getByRole("heading", { name: "거래 수정", exact: true })).toHaveCount(0);
});

test("cancel and native Back protect dirty draft and restore filter, scroll, focus", async ({ page }) => {
  await mockEditor(page, makeDetail(), false);
  const list = Array.from({ length: 70 }, (_, i) => historyTxn(makeDetail({ id: 71 + i, description: `거래 ${i}` })));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: list }));
  await page.goto("/transactions?tag=데이트");
  const button = page.locator("#edit-transaction-71"); await button.scrollIntoViewIfNeeded();
  const scroll = await page.locator(".main").evaluate(e => e.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await button.click(); await expect(item(page)).toBeVisible();
  await memo(page).fill("아직 저장 전");
  const dismissed = new Promise<void>(resolve => page.once("dialog", async d => { await d.dismiss(); resolve(); }));
  await cancel(page).click(); await dismissed;
  await expect(memo(page)).toHaveValue("아직 저장 전");
  const accepted = new Promise<void>(resolve => page.once("dialog", async d => { await d.accept(); resolve(); }));
  await page.goBack(); await accepted;
  await expect(page.getByLabel("태그", { exact: true })).toHaveValue("데이트"); await expect(button).toBeFocused();
  await expect.poll(() => page.locator(".main").evaluate(e => e.scrollTop)).toBe(scroll);
  await button.click(); await expect(item(page)).toBeVisible();
  let dialogs = 0; page.on("dialog", d => { dialogs++; return d.dismiss(); });
  await cancel(page).click(); await expect(button).toBeFocused(); expect(dialogs).toBe(0);
  await expect.poll(() => page.locator(".main").evaluate(e => e.scrollTop)).toBe(scroll);
});

test("saved edit restores actual long-list scroll and focus", async ({ page }) => {
  await mockEditor(page, makeDetail(), false);
  const list = Array.from({ length: 70 }, (_, i) => historyTxn(makeDetail({ id: 71 + i, description: `거래 ${i}` })));
  await page.route("**/api/transactions?*", r => r.fulfill({ json: list }));
  await page.goto("/transactions?tag=데이트");
  const button = page.locator("#edit-transaction-71"); await button.scrollIntoViewIfNeeded();
  const scroll = await page.locator(".main").evaluate(e => e.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await button.click(); await expect(save(page)).toBeEnabled();
  await memo(page).fill("저장 후 복귀"); await save(page).click();
  await expect(button).toBeFocused();
  await expect(page.getByLabel("태그", { exact: true })).toHaveValue("데이트");
  await expect.poll(() => page.locator(".main").evaluate(e => e.scrollTop)).toBe(scroll);
});

test("conflict recovery wraps long memo text on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockEditor(page);
  const oldMemo = "초안".repeat(900), latestMemo = "최신".repeat(900);
  await page.route("**/api/transactions/71", r => r.request().method() === "PUT"
    ? r.fulfill({ status: 409, json: { detail: "변경 충돌" } })
    : r.fulfill({ json: makeDetail({ memo: latestMemo, version: "c".repeat(32) }) }));
  await memo(page).fill(oldMemo); await save(page).click();
  await page.getByText("저장하지 못한 작성 내용", { exact: true }).click();
  await page.getByRole("button", { name: "최신 거래 확인", exact: true }).click();
  const previews = page.locator(".edit-recovery pre");
  await expect(previews).toHaveCount(2);
  expect(await previews.allTextContents()).toEqual([oldMemo, latestMemo]);
  for (const preview of await previews.all()) {
    await expect(preview).toHaveCSS("white-space", "pre-wrap");
    expect(await preview.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  }
});

test("reverting an amount removes leave protection despite comma formatting", async ({ page }) => {
  const original = makeDetail({ postings: makeDetail().postings.map(p => ({ ...p, amount: p.amount * 10 })) });
  await mockEditor(page, original);
  const prevented = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
  });
  await amount(page).fill("2000"); await expect.poll(prevented).toBe(true);
  await amount(page).fill("1000"); await expect(amount(page)).toHaveValue("1,000");
  await expect.poll(prevented).toBe(false);
  let dialogs = 0; page.on("dialog", d => { dialogs++; return d.dismiss(); });
  await cancel(page).click(); await expect(page).toHaveURL(/\/transactions$/);
  expect(dialogs).toBe(0);
});

test("failed detail and tags queries can retry without losing loaded draft", async ({ page }) => {
  await mockEditor(page, makeDetail(), false); let detailFails = true, tagsFail = true;
  await page.route("**/api/transactions/71", r => detailFails ? r.fulfill({ status: 500, json: { detail: "조회 오류" } }) : r.fulfill({ json: makeDetail() }));
  await page.route("**/api/tags", r => tagsFail ? r.fulfill({ status: 500, json: { detail: "태그 오류" } }) : r.fulfill({ json: [] }));
  await page.goto("/transactions/71/edit");
  await expect(page.getByRole("alert")).toContainText("거래를 불러오지 못했습니다"); detailFails = false;
  await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await expect(item(page)).toBeVisible(); await memo(page).fill("로딩 오류에도 유지"); await expect(save(page)).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("계정 또는 태그를 불러오지 못했습니다"); tagsFail = false;
  await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
  await expect(save(page)).toBeEnabled(); await expect(memo(page)).toHaveValue("로딩 오류에도 유지");
});

test("foreign currency is visibly unsupported and never silently converted", async ({ page }) => {
  await mockEditor(page, makeDetail({ editable: false, postings: makeDetail().postings.map(p => ({ ...p, currency: "USD" })) }));
  await expect(page.getByText("현재 지원하지 않는 통화 또는 시스템 거래입니다. 원본을 원화로 변환하지 않습니다.")).toBeVisible();
  await expect(save(page)).toBeDisabled(); await expect(amount(page)).toBeDisabled();
});

test("successful save remains successful when the refreshed history fails", async ({ page }) => {
  await mockEditor(page); await page.route("**/api/transactions?*", r => r.fulfill({ status: 500, json: { detail: "목록 실패" } }));
  await memo(page).fill("확정된 수정"); await save(page).click();
  await expect(page).toHaveURL(/\/transactions$/); await expect(page.getByRole("alert")).toContainText("거래 내역을 불러오지 못했습니다");
  await expect(page.getByRole("status").filter({ hasText: "거래를 수정했습니다." })).toBeVisible();
});

test("mobile shared editor supports IME, multiline memo, keyboard and accessible layout", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await mockEditor(page);
  let puts = 0; await page.route("**/api/transactions/71", r => { puts++; return r.abort(); });
  await item(page).dispatchEvent("compositionstart"); await item(page).fill("한글"); await item(page).press("Enter");
  await page.locator("form").dispatchEvent("submit"); expect(puts).toBe(0); await item(page).dispatchEvent("compositionend");
  await memo(page).fill("첫 줄"); await memo(page).press("Enter"); await memo(page).pressSequentially("둘째 줄"); expect(puts).toBe(0);
  const tag = page.getByLabel("태그 (선택·여러 개)", { exact: true });
  await tag.dispatchEvent("compositionstart"); await tag.fill("여행"); await tag.press("Enter");
  await expect(page.getByRole("button", { name: "여행 태그 제거", exact: true })).toHaveCount(0);
  await tag.dispatchEvent("compositionend"); await tag.press("Enter");
  await expect(page.getByRole("button", { name: "여행 태그 제거", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const audit = await new AxeBuilder({ page }).include(".txn-page").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("transaction-edit-mobile.png"), fullPage: true });
});
