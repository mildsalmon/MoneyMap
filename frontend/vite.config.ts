import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 일반 개발은 5173을 고정하고, E2E는 CLI --port와 CORS 환경변수로 격리한다.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
