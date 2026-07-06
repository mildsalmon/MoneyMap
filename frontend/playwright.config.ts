import { defineConfig } from "@playwright/test";

/**
 * E2E — What-if 핵심 flow 1개 (D10).
 * 전용 임시 DB로 격리: 백엔드 기동 명령이 직접 DB를 초기화하므로
 * globalSetup/webServer 실행 순서에 의존하지 않는다.
 * 주의: 8765/5173 포트를 쓰므로 dev 서버가 떠 있으면 종료 후 실행.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "rm -f /tmp/moneymap-e2e.db && rm -rf /tmp/backups && cd ../backend && MONEYMAP_DB=/tmp/moneymap-e2e.db uv run uvicorn moneymap.api:app --port 8765",
      url: "http://127.0.0.1:8765/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
