import { test, expect, type Page } from "./test";
import AxeBuilder from "@axe-core/playwright";
import { newDraft, setTags } from "../src/views/transactionInputState";

const tagInput = (page: Page) => page.getByRole("combobox", { name: "태그 (선택·여러 개)", exact: true });
const chip = (page: Page, name: string) => page.getByRole("button", { name: `${name} 태그 제거`, exact: true });
const accounts = [
  { id: 101, name: "태그 비용", type: "expense" },
  { id: 102, name: "태그 통장", type: "asset" },
].map((account, position) => ({ ...account, position, currency: "KRW", version: 1, parent_id: null,
  archived: false, is_system: false, is_placeholder: false, is_overdraft: false }));
async function start(page: Page, tags: string[] = ["데이트", "여행", "엄마"]) {
  await page.route("**/api/accounts", r => r.fulfill({ json: accounts }));
  await page.route("**/api/tags", r => r.fulfill({ json: tags }));
  await page.route("**/api/transaction-input/recent?*", r => r.fulfill({ json: [] }));
  await page.route("**/api/transaction-input/last-pair?*", r => r.fulfill({ json: { status: "none", debit_account_id: null, credit_account_id: null } }));
  await page.goto("/transactions/new");
  await expect(page.locator(".side .health")).not.toContainText("상태 확인 중");
  await expect(page.getByRole("group", { name: "차변 계정", exact: true }).locator('input[data-account="101"]')).toBeAttached();
}
async function ready(page: Page) {
  await page.getByRole("group", { name: "차변 계정", exact: true }).getByRole("radio", { name: /태그 비용$/ }).check();
  await page.getByRole("group", { name: "대변 계정", exact: true }).getByRole("radio", { name: /태그 통장$/ }).check();
  await page.getByLabel("금액", { exact: true }).fill("1000");
}

test("tag normalization preserves names and deduplicates NFC, spaces and letter case", () => {
  expect(setTags(newDraft("2026-10-24"), [" Cafe\u0301 ", "Café", "Travel", "travel", " 여행 ", ""]).tags)
    .toEqual(["Café", "Travel", "여행"]);
});

test("keyboard selects and creates multiple tags without submitting; save includes only selected tags", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await start(page); await ready(page);
  const writes: any[] = [];
  await page.route("**/api/transactions", async r => {
    if (r.request().method() !== "POST") return r.continue();
    writes.push(r.request().postDataJSON()); await r.fulfill({ status: 201, json: { id: 9901 } });
  });
  await tagInput(page).fill("여"); await tagInput(page).press("ArrowDown");
  await expect(page.getByRole("option", { name: "여행", exact: true })).toHaveAttribute("aria-selected", "true");
  await tagInput(page).press("Enter"); await expect(chip(page, "여행")).toBeVisible();
  await tagInput(page).fill("새 태그");
  await page.getByRole("option", { name: "새 태그 새 태그 추가", exact: true }).click();
  expect(writes).toHaveLength(0);
  await expect(tagInput(page)).toBeFocused();
  await page.screenshot({ path: info.outputPath("tag-picker-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "저장 (Enter)", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].tags).toEqual(["여행", "새 태그"]);
  await expect(page.getByLabel("선택한 태그")).toHaveCount(0);
});

test("Escape, Tab, outside focus and pointer toggle close choices without changing selections", async ({ page }) => {
  await start(page);
  await tagInput(page).fill("데이트"); await tagInput(page).press("Enter");
  await tagInput(page).fill("여"); await tagInput(page).press("ArrowDown"); await tagInput(page).press("Escape");
  await expect(tagInput(page)).toHaveAttribute("aria-expanded", "false");
  await expect(tagInput(page)).toHaveValue("여"); await expect(chip(page, "데이트")).toBeVisible();
  await page.getByRole("button", { name: "태그 목록 열기" }).click();
  await expect(tagInput(page)).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "태그 목록 닫기" }).click();
  await expect(tagInput(page)).toHaveAttribute("aria-expanded", "false");
  await tagInput(page).press("ArrowDown"); await tagInput(page).press("Tab");
  await expect(tagInput(page)).toHaveAttribute("aria-expanded", "false");
  await tagInput(page).focus(); await page.getByLabel("아이템 (선택)", { exact: true }).focus();
  await expect(page.getByRole("listbox", { name: "태그 검색 결과" })).toHaveCount(0);
  await chip(page, "데이트").click(); await expect(chip(page, "데이트")).toHaveCount(0);
  await expect(tagInput(page)).toBeFocused();
});

test("IME and keyCode229 cannot add tags or submit; exact canonical catalog spelling is reused", async ({ page }) => {
  await start(page, ["Café", "Travel"]); await ready(page);
  let writes = 0; await page.route("**/api/transactions", r => { writes++; return r.abort(); });
  await tagInput(page).dispatchEvent("compositionstart"); await tagInput(page).fill("한글");
  await tagInput(page).press("Enter"); await page.locator("form").dispatchEvent("submit");
  expect(writes).toBe(0); await expect(chip(page, "한글")).toHaveCount(0);
  await tagInput(page).dispatchEvent("compositionend");
  await tagInput(page).dispatchEvent("keydown", { key: "Enter", keyCode: 229 });
  await expect(chip(page, "한글")).toHaveCount(0);
  await tagInput(page).press("Enter"); await expect(chip(page, "한글")).toBeVisible();
  await tagInput(page).fill(" Cafe\u0301 "); await tagInput(page).press("Enter");
  await expect(chip(page, "Café")).toBeVisible();
  await tagInput(page).fill("CAFÉ"); await tagInput(page).press("Enter");
  await expect(chip(page, "Café")).toHaveCount(1);
  await expect(page.locator(".tag-announcement")).toHaveText("이미 선택한 태그입니다");
  expect(writes).toBe(0);
});

test("20-tag limit keeps removal reachable and never silently replaces a selection", async ({ page }) => {
  await start(page, []);
  for (let i = 1; i <= 20; i++) { await tagInput(page).fill(`태그${i}`); await tagInput(page).press("Enter"); }
  await expect(tagInput(page)).toBeDisabled();
  await expect(chip(page, "태그20")).toBeFocused();
  await expect(page.getByLabel("선택한 태그").getByRole("button")).toHaveCount(20);
  await chip(page, "태그20").click();
  await expect(tagInput(page)).toBeEnabled(); await expect(chip(page, "태그19")).toBeFocused();
  await tagInput(page).fill("다른 태그"); await tagInput(page).press("Enter");
  await expect(chip(page, "태그1")).toBeVisible(); await expect(chip(page, "다른 태그")).toBeVisible();
});

test("50-character creation boundary is explicit and a longer draft stays editable", async ({ page }) => {
  await start(page, []);
  const maximum = "가".repeat(50), longer = "나".repeat(51);
  await tagInput(page).fill(maximum); await tagInput(page).press("Enter");
  await expect(chip(page, maximum)).toBeVisible();
  await tagInput(page).fill(longer); await tagInput(page).press("Enter");
  await expect(chip(page, longer)).toHaveCount(0); await expect(tagInput(page)).toHaveValue(longer);
  await expect(tagInput(page)).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".tag-hint")).toHaveText("태그는 50자까지 입력할 수 있습니다");
  await tagInput(page).fill("수정한 태그"); await tagInput(page).press("Enter");
  await expect(chip(page, "수정한 태그")).toBeVisible();
});

test("late creation response preserves tag edits made for the next draft", async ({ page }) => {
  await start(page); await ready(page);
  let release!: () => void, submitted: any;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/transactions", async r => {
    if (r.request().method() !== "POST") return r.continue();
    submitted = r.request().postDataJSON(); await gate; await r.fulfill({ status: 201, json: { id: 9902 } });
  });
  await tagInput(page).fill("데이트"); await tagInput(page).press("Enter");
  await page.getByRole("button", { name: "저장 (Enter)", exact: true }).click();
  await expect.poll(() => submitted?.tags).toEqual(["데이트"]);
  await tagInput(page).fill("여행"); await tagInput(page).press("Enter"); release();
  await expect(page.getByRole("button", { name: "저장 (Enter)", exact: true })).toBeEnabled();
  await expect(chip(page, "데이트")).toBeVisible(); await expect(chip(page, "여행")).toBeVisible();
});

test("large catalog remains searchable on mobile with named controls, visible focus and touch targets", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tags = Array.from({ length: 60 }, (_, i) => `기존 태그 ${String(i).padStart(2, "0")}`);
  const long = "긴 태그 이름 ".repeat(5); await start(page, [...tags, long]);
  await tagInput(page).focus(); await expect(page.getByRole("option")).toHaveCount(30);
  await expect(page.getByText("검색 결과 중 30개 표시 · 더 입력해 좁혀보세요")).toBeVisible();
  await tagInput(page).fill("기존 태그 59"); await tagInput(page).press("ArrowDown"); await tagInput(page).press("Enter");
  await expect(chip(page, "기존 태그 59")).toBeVisible();
  await tagInput(page).fill(long); await tagInput(page).press("Enter");
  await expect(chip(page, long.trim())).toBeVisible();
  await tagInput(page).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await chip(page, long.trim()).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await page.getByRole("option").first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).include(".transaction-tag-picker").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("tag-picker-mobile.png"), fullPage: true });
});
