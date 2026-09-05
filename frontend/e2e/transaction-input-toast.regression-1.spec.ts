import { expect, test } from "./test";

// Regression: ISSUE-001 — the fixed mobile save bar hid confirmation and undo.
// Found by /qa on 2026-09-05
// Report: docs/verification/transaction-input-qa.md
for (const mode of ["basic", "split"] as const) {
  for (const [label, item] of [
    ["ordinary item", "회사 근처 점심 식사와 카페 이용 내역"],
    ["unbroken item", "A".repeat(60)],
    ["very long item", "A".repeat(2000)],
  ]) {
    test(`${mode}, ${label}: mobile confirmation clears the save bar and undo remains clickable`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const accounts = [
        { id: 1, name: "외식", type: "expense" },
        { id: 2, name: "현금", type: "asset" },
      ].map((a, position) => ({ parent_id: null, currency: "KRW", archived: false, is_placeholder: false, is_system: false, is_overdraft: false, version: 1, position, ...a }));
      const deleted: string[] = [];
      await page.route("**/api/**", route => {
        const url = new URL(route.request().url());
        if (!url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname === "/api/accounts") return route.fulfill({ json: accounts });
        if (url.pathname === "/api/status") return route.fulfill({ json: { trial_balance_ok: true, last_backup: "2026-09-05", last_entry: null } });
        if (url.pathname === "/api/materialize") return route.fulfill({ json: { created: 0, transactions: [] } });
        if (url.pathname === "/api/transaction-input/last-pair") return route.fulfill({ json: { item_key: url.searchParams.get("item"), status: "matched", source_transaction_id: 90, debit_account_id: 1, credit_account_id: 2, unavailable_reason: null } });
        if (url.pathname === "/api/transactions" && route.request().method() === "POST") return route.fulfill({ status: 201, json: { id: 91 } });
        if (url.pathname === "/api/transactions/91" && route.request().method() === "DELETE") { deleted.push(url.pathname); return route.fulfill({ json: { deleted: 91 } }); }
        return route.fulfill({ json: [] });
      });
      await page.goto("/transactions/new");
      await page.getByLabel("아이템 (선택)", { exact: true }).fill(item);
      await page.getByLabel("금액", { exact: true }).fill("7500");
      await expect(page.getByRole("button", { name: "저장 (Enter)", exact: true })).toBeEnabled();
      if (mode === "split") await page.getByRole("button", { name: "분할 입력", exact: true }).click();
      await page.getByRole("button", { name: "저장 (Enter)", exact: true }).click();
      const toast = page.locator(".toast"), bar = page.locator(".txn-savebar");
      await expect(toast).toContainText("저장됨");
      // The toast must stay above a dynamically resized bar, including wrapped text.
      for (const width of [390, 320, 720]) {
        await page.setViewportSize({ width, height: 844 });
        await expect.poll(async () => {
          const t = await toast.boundingBox(), b = await bar.boundingBox();
          return t!.y + t!.height <= b!.y - 10;
        }).toBe(true);
        expect(await toast.getByRole("button", { name: "실행취소" }).evaluate(e => {
          const b = e.getBoundingClientRect();
          return b.x >= 0 && b.right <= innerWidth && b.y >= 0 && b.bottom <= innerHeight
            && document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === e;
        })).toBe(true);
      }
      await toast.getByRole("button", { name: "실행취소" }).click();
      await expect.poll(() => deleted).toEqual(["/api/transactions/91"]);
      await expect(toast).toBeHidden();
      await page.setViewportSize({ width: 390, height: 460 });
      await expect(bar).toHaveCSS("position", "static");
      await page.locator(".side nav").getByRole("button", { name: "거래 내역", exact: true }).click();
      await expect.poll(() => page.locator(".shell").evaluate(e => e.style.getPropertyValue("--transaction-savebar-height"))).toBe("");
    });
  }
}
