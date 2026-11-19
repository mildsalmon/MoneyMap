import { expect, test } from "./test";
import { chooseAccount, clearSavedDraft, switchMode, validateDraft } from "../src/views/transactionInputState";
import { draftIdentity, editDraft } from "../src/views/transactionEditState";

const base = process.env.MONEYMAP_E2E_API_BASE
  ?? `http://127.0.0.1:${process.env.MONEYMAP_E2E_BACKEND_PORT ?? 8765}/api`;

test("one tagged split receipt keeps its identities, balances and total when reclassified and renamed", async ({ page, request }) => {
  const suffix = Date.now();
  const names = [`식비 ${suffix}`, `통장 ${suffix}`, `교통비 ${suffix}`];
  for (const [i, type] of ["expense", "asset", "expense"].entries()) {
    const response = await request.post(`${base}/accounts`, { data: { name: names[i], type } });
    expect(response.ok()).toBe(true);
  }
  const delivery = `배달 ${suffix}`, transit = `교통 ${suffix}`, dining = `외식 ${suffix}`, renamed = `식당 ${suffix}`;
  await page.goto("/transactions/new");
  await page.getByText("생활 분류 관리", { exact: true }).click();
  for (const name of [delivery, transit, dining]) {
    await page.getByLabel("분류 이름", { exact: true }).fill(name);
    await page.getByRole("button", { name: "분류 추가", exact: true }).click();
    await expect(page.getByLabel("관리할 분류").getByRole("option", { name, exact: true })).toBeAttached();
  }
  const item = `출장 영수증 ${suffix}`;
  await page.getByLabel("아이템 (선택)").fill(item);
  const tag = page.getByRole("combobox", { name: "태그 (선택·여러 개)" });
  await tag.fill("출장");
  await tag.press("Enter");
  await page.getByRole("button", { name: "분할 입력", exact: true }).click();
  await page.getByRole("button", { name: "+ 행 추가" }).click();
  for (const [i, amount] of [8000, 12000, 4000].entries()) {
    await page.getByRole("button", { name: new RegExp(`^${i + 1}행 계정`) }).click();
    await page.getByRole("radio", { name: new RegExp(`${names[i]}$`) }).click();
    await page.getByLabel(`${i + 1}행 금액`).fill(String(amount));
  }
  await page.getByLabel("1행 생활 분류").selectOption({ label: delivery });
  await expect(page.getByLabel("2행 생활 분류")).toHaveCount(0);
  await page.getByLabel("3행 생활 분류").selectOption({ label: transit });
  const day = await page.getByLabel("날짜", { exact: true }).inputValue();
  const report = async () => (await request.get(`${base}/statistics?start=${day}&end=${day}`)).json();
  const before = await report();
  const save = page.waitForResponse(r => r.url() === `${base}/transactions` && r.request().method() === "POST");
  await page.getByRole("button", { name: "저장 (Enter)" }).click();
  const response = await save;
  expect(response.status()).toBe(201);
  const url = `${base}/transactions/${(await response.json()).id}`;
  try {
    const ledger = await report();
    expect(ledger.summary.expense - before.summary.expense).toBe(12000);
    const original = await (await request.get(url)).json();
    expect(original.tags).toEqual(["출장"]);
    const nav = page.getByRole("navigation", { name: "주 메뉴" });
    await nav.getByRole("button", { name: "통계" }).click();
    const table = page.getByRole("table", { name: "생활 분류별 수입과 지출" });
    await expect(table.getByRole("row").filter({ hasText: delivery })).toContainText("₩8,000");
    await expect(table.getByRole("row").filter({ hasText: transit })).toContainText("₩4,000");
    const assetTable = page.getByRole("table", { name: "기간말 자산 구성" });
    const balance = assetTable.getByRole("row").filter({ hasText: names[1] });
    await expect(balance).toContainText("−₩12,000");
    await nav.getByRole("button", { name: "거래 내역" }).click();
    await page.getByRole("row").filter({ hasText: item }).getByRole("button", { name: "수정" }).click();
    await page.getByLabel("1행 생활 분류").selectOption({ label: dining });
    await page.getByRole("button", { name: "변경사항 저장" }).click();
    const receipt = page.getByRole("row").filter({ hasText: item });
    await receipt.getByRole("button", { name: "수정" }).click();
    await page.getByText("생활 분류 관리", { exact: true }).click();
    await page.getByLabel("관리할 분류").selectOption({ label: dining });
    await page.getByLabel("분류 이름", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "분류 이름 변경" }).click();
    await expect(page.getByLabel("1행 생활 분류").locator("option:checked")).toHaveText(renamed);
    await nav.getByRole("button", { name: "통계" }).click();
    await expect(table.getByRole("row").filter({ hasText: renamed })).toContainText("₩8,000");
    await expect(table.getByRole("row").filter({ hasText: transit })).toContainText("₩4,000");
    await expect(balance).toContainText("−₩12,000");
    const after = await report();
    expect(after.summary).toEqual(ledger.summary);
    expect(after.balances).toEqual(ledger.balances);
    const edited = await (await request.get(url)).json();
    expect(edited.id).toBe(original.id);
    expect(edited.tags).toEqual(original.tags);
    const legs = (rows: { posting_id: number; account_id: number; amount: number }[]) =>
      rows.map(({ posting_id, account_id, amount }) => [posting_id, account_id, amount]);
    expect(legs(edited.postings)).toEqual(legs(original.postings));
  } finally {
    await request.delete(url);
  }
});


test("basic edits carry posting categories through mode switches and clear only the affected selection", () => {
  const original = editDraft({
    id: 1, version: "0".repeat(32), date: "2026-11-01", description: "", memo: "", tags: [],
    editable: true, kind: "regular", entry_origin: "user", opening_system_id: null, source_rule_id: null,
    postings: [{ posting_id: 41, account_id: 2, amount: 8000, currency: "KRW", category_id: 7 },
      { posting_id: 42, account_id: 3, amount: -8000, currency: "KRW" }],
  });
  const restored = switchMode(switchMode(original).draft).draft;
  expect(draftIdentity(restored)).toBe(draftIdentity(original));
  expect(validateDraft(restored, new Set([2, 3])).postings[0]).toMatchObject({ category_id: 7, posting_id: 41 });
  const reassigned = chooseAccount(restored, "debit", 4);
  expect(validateDraft(reassigned, new Set([3, 4])).postings[0]).toMatchObject({ category_id: null, posting_id: 41 });
  expect(draftIdentity({ ...original, debit: { ...original.debit, categoryId: 8 } })).not.toEqual(draftIdentity(original));
  expect(clearSavedDraft(original, original).debit.categoryId).toBeUndefined();
});
