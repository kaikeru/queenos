/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the deployed Queen, e.g. https://queen.example.workers.dev. Unset in dev (Vite proxy). */
  readonly VITE_QUEEN_URL?: string;
  /** "1" serves /api/* from the in-browser mock (dev/recording only). */
  readonly VITE_MOCK_API?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
