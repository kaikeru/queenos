import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the SPA talks to its own origin. Vite proxies
//   /hives (REST + WebSocket) -> the local `wrangler dev` Queen (QUEEN_DEV_URL, default :8787)
//   /api                      -> the local Edge Worker          (EDGE_DEV_URL,  default :8788)
// With VITE_MOCK_API=1 the SPA answers /api itself and the /api proxy is never hit.
// Production: the Edge serves the SPA, /api and /hives from one origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/hives": { target: env.QUEEN_DEV_URL || "http://localhost:8787", ws: true, changeOrigin: true },
        "/api": { target: env.EDGE_DEV_URL || "http://localhost:8788", changeOrigin: true },
      },
    },
  };
});
