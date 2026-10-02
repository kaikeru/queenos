import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the SPA talks to its own origin and Vite proxies /hives (REST + WebSocket)
// to the local `wrangler dev` Queen. Override with QUEEN_DEV_URL.
// Production: set VITE_QUEEN_URL to the deployed Queen's URL.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/hives": { target: env.QUEEN_DEV_URL || "http://localhost:8787", ws: true, changeOrigin: true },
      },
    },
  };
});
