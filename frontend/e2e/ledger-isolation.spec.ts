import { expect, test } from "./test";
import { withLedger } from "./withLedger";

test("timed-out ledger teardown prevents a delayed POST from reaching the shared database", async ({ browser, page, request }, info) => {
  // Stand in for the shared API with another disposable DB, even when CI supplies an external API.
  await withLedger(page, info.outputPath("shared.db"), "empty", async sharedApi => {
    const privatePage = await browser.newPage();
    const accountCount = async (api: string, name: string) => {
      const response = await request.get(`${api}/accounts`);
      expect(response.ok()).toBe(true);
      const accounts: { name: string }[] = await response.json();
      return accounts.filter(account => account.name === name).length;
    };
    let releasePost!: () => void;
    const gate = new Promise<void>(resolve => { releasePost = resolve; });
    let notifyWaiting!: () => void;
    const waiting = new Promise<void>(resolve => { notifyWaiting = resolve; });
    await privatePage.exposeFunction("waitToPost", () => {
      notifyWaiting();
      return gate;
    });
    let delayedPost: Promise<number | null> | undefined;
    try {
      const isolated = withLedger(privatePage, info.outputPath("private.db"), "empty", async privateApi => {
        await privatePage.route("**/ledger-test", route => route.fulfill({ contentType: "text/html", body: "<title>ledger</title>" }));
        await privatePage.goto(new URL("/ledger-test", sharedApi).href);
        const post = (name: string, delayed = false) => privatePage.evaluate(async ({ name, delayed }) => {
          if (delayed) await (window as Window & { waitToPost(): Promise<void> }).waitToPost();
          const response = await fetch("/api/accounts", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, type: "asset" }),
          });
          return response.status;
        }, { name, delayed });

        expect(await post("정상 저장")).toBe(201);
        expect(await accountCount(privateApi, "정상 저장")).toBe(1);
        delayedPost = post("정리 뒤 저장", true).catch(() => null);
        await waiting;
        // End the fixture callback on a deadline while the browser still has a write queued.
        await Promise.race([delayedPost, new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("intentional ledger deadline")), 50);
        })]);
      });

      await expect(isolated).rejects.toThrow("intentional ledger deadline");
      releasePost();
      const result = await delayedPost;
      expect(await accountCount(sharedApi, "정상 저장")).toBe(0);
      expect(await accountCount(sharedApi, "정리 뒤 저장")).toBe(0);
      expect(result).toBeNull();
    } finally {
      releasePost();
      await privatePage.close();
    }
  });
});
