import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 백엔드 CORS 허용 목록이 5173 고정이므로 strictPort (D17-eng)
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
