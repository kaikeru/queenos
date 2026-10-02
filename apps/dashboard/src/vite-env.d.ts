/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the deployed Queen, e.g. https://queen.example.workers.dev. Unset in dev (Vite proxy). */
  readonly VITE_QUEEN_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
