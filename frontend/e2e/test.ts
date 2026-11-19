import { expect, test as base } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

/** Account pickers request the same inventory at a specific Seoul day close. */
export const accountListUrl = /\/api\/accounts(?:\?on=[\d-]+)?$/;

/** Keep browser tests independent of third-party font/CDN availability. */
export async function blockExternalStyles(page: Page | BrowserContext) {
  await page.route(
    /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com)\//,
    route => route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await blockExternalStyles(page);
    await use(page);
  },
});

export { expect };
export type { APIRequestContext, Page, Request, Route } from "@playwright/test";
