import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Page } from "./test";

// Give each test a real API and its own DB, including when the suite is
// configured with an external API. Only the browser's API destination changes.
export async function withLedger(page: Page, db: string, mode: "mixed" | "won" | "empty", check: (api: string) => Promise<void>) {
  const cwd = resolve("../backend");
  const python = execFileSync("uv", ["run", "python", "-c", "import sys;print(sys.executable)"], {cwd, encoding:"utf8"}).trim();
  const server = spawn(python, ["-u", "-c", `
import os, sys, uvicorn
if sys.argv[1] != "empty":
    from moneymap.app_services.scenarios import now
    from test_dashboard_krw import seed_v8
    seed_v8(os.environ["MONEYMAP_DB"], now().date(), sys.argv[1] == "mixed")
uvicorn.run("moneymap.api:app", host="127.0.0.1", port=0, access_log=False)
`, mode], {cwd, env: {...process.env, MONEYMAP_DB: db, PYTHONPATH: resolve(cwd, "tests")}, stdio:["ignore", "ignore", "pipe"]});
  const exited = once(server, "exit");
  const logs = createInterface({input:server.stderr});
  try {
    let url = "";
    const details: string[] = [];
    for await (const line of logs) {
      details.push(line);
      const match = line.match(/Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { url = match[1]; break; }
    }
    if (!url) throw new Error(details.join("\n"));
    await page.route(url => url.pathname.startsWith("/api/"), async route => {
      const {pathname, search} = new URL(route.request().url());
      const response = await route.fetch({url: url + pathname + search});
      await route.fulfill({response});
    });
    await check(url + "/api");
  } finally {
    await page.unrouteAll({behavior:"wait"});
    logs.close();
    server.kill();
    await exited;
  }
}
