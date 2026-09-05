import { expect, test } from "./test";

test("API client preserves structured context, native validation, and cancellation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/api/core.ts";
    const { req, ApiError } = await import(modulePath);
    const originalFetch = window.fetch;
    async function capture(detail: unknown, status: number) {
      window.fetch = async () => new Response(JSON.stringify({ detail }), { status, headers: { "Content-Type": "application/json" } });
      try {
        await req("/contract");
        throw new Error("Expected API failure");
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const e = error as Error & { status: number; code: string; context: unknown; detail: unknown };
        return { status: e.status, code: e.code, message: e.message, context: e.context, detail: e.detail };
      }
    }
    try {
      const envelope = { code: "scenario_duplicate_date_conflict", message: "날짜를 확인하세요", scenario_id: 7, conflicts: [{ transaction_id: 30, date: "2026-09-01" }], retryable: false };
      const structured = await capture(envelope, 409);
      const validation = [{ type: "missing", loc: ["body", "name"], msg: "Field required", input: {} }];
      const native = await capture(validation, 422);
      const legacy = await capture("legacy message", 400);
      window.fetch = originalFetch;
      const controller = new AbortController();
      controller.abort();
      let aborted = false;
      try { await req("/health", { signal: controller.signal }); }
      catch (error) { aborted = error instanceof DOMException && error.name === "AbortError"; }
      return { structured, native, legacy, aborted };
    } finally { window.fetch = originalFetch; }
  });
  expect(result.structured).toEqual({
    status: 409, code: "scenario_duplicate_date_conflict", message: "날짜를 확인하세요",
    context: { scenario_id: 7, conflicts: [{ transaction_id: 30, date: "2026-09-01" }], retryable: false },
    detail: { code: "scenario_duplicate_date_conflict", message: "날짜를 확인하세요", scenario_id: 7, conflicts: [{ transaction_id: 30, date: "2026-09-01" }], retryable: false },
  });
  expect(result.native.status).toBe(422);
  expect(result.native.detail).toEqual([{ type: "missing", loc: ["body", "name"], msg: "Field required", input: {} }]);
  expect(result.legacy.message).toBe("legacy message");
  expect(result.aborted).toBe(true);
});
