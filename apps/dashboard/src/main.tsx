import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

async function boot() {
  // VITE_MOCK_API=1 serves /api from an in-browser mock. The literal comparison
  // is replaced at build time, so the dynamic import is tree-shaken from prod bundles.
  if (import.meta.env.VITE_MOCK_API === "1") {
    const { installMockApi } = await import("./mock");
    installMockApi();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
void boot();
