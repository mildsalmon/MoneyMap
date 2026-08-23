import { defineConfig } from "@playwright/test";

function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a numeric TCP port`);
  const port = Number(raw);
  if (port < 1 || port > 65_535) throw new Error(`${name} must be between 1 and 65535`);
  return port;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const backendPort = portFromEnv("MONEYMAP_E2E_BACKEND_PORT", 8765);
const frontendPort = portFromEnv("MONEYMAP_E2E_FRONTEND_PORT", 5173);
const frontendBase = `http://127.0.0.1:${frontendPort}`;
const localApiBase = `http://127.0.0.1:${backendPort}/api`;
const externalApiBase = process.env.MONEYMAP_E2E_API_BASE?.replace(/\/+$/, "");
const apiBase = externalApiBase ?? localApiBase;
const testRoot = `/tmp/moneymap-e2e-${backendPort}`;

/**
 * E2E — 포트별 임시 DB로 격리한다. 모든 spec이 같은 DB를 공유하므로
 * worker를 하나로 고정해 상태 변경 순서를 결정적으로 유지한다.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: frontendBase,
    trace: "retain-on-failure",
  },
  webServer: [
    ...(externalApiBase ? [] : [{
      command:
        `mkdir -p ${shellQuote(testRoot)} && rm -f ${shellQuote(`${testRoot}/moneymap.db`)} && `
        + `rm -rf ${shellQuote(`${testRoot}/backups`)} && `
        + `cd ../backend && MONEYMAP_DB=${shellQuote(`${testRoot}/moneymap.db`)} `
        + `MONEYMAP_CORS_ORIGINS=${shellQuote(frontendBase)} `
        + `uv run uvicorn moneymap.api:app --port ${backendPort}`,
      url: `${localApiBase}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    }]),
    {
      command: `VITE_API_BASE=${shellQuote(apiBase)} npm run dev -- --host 127.0.0.1 --port ${frontendPort}`,
      url: frontendBase,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
