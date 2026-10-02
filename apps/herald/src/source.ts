/**
 * Read a deployable no-build Worker out of a cloned tree (templates/worker-starter).
 *
 * Convention: `.queen/deploy.json` `{ "main": "src/index.js", "compatibility_date": "…" }`;
 * every `src/**\/*.js` file is uploaded as an ES module named by its repo path.
 */
import { z } from "zod";
import { JS_MODULE_TYPE, type DeployModule } from "@queenos/hive-kit";
import type { GitSession } from "./ports";

export const DEPLOY_CONFIG_PATH = ".queen/deploy.json";
export const MAX_MODULES = 100;
export const MAX_MODULE_BYTES = 256 * 1024;
/** Stays below the 1 MiB Workflow step-result limit even with JSON overhead. */
export const MAX_TOTAL_BYTES = 768 * 1024;

export const DeployConfigSchema = z.object({
  main: z.string().min(1).max(200),
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type DeployConfig = z.infer<typeof DeployConfigSchema>;

export interface WorkerSource {
  mainModule: string;
  compatibilityDate: string;
  modules: DeployModule[];
  totalBytes: number;
}

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;

/** Thrown for source problems a retry cannot fix; the orchestrator makes it non-retryable. */
export class SourceError extends Error {
  override readonly name = "SourceError";
}

export const isModulePath = (p: string) => p.startsWith("src/") && p.endsWith(".js") && !p.includes("..") && !p.includes("//");

export async function readWorkerSource(repo: GitSession): Promise<WorkerSource> {
  const files = await repo.listFiles();
  if (!files.includes(DEPLOY_CONFIG_PATH)) throw new SourceError(`${DEPLOY_CONFIG_PATH} not found: the tree is not a deployable no-build Worker`);

  const paths = files.filter(isModulePath).sort();
  if (paths.length === 0) throw new SourceError("no src/**/*.js modules to upload");
  if (paths.length > MAX_MODULES) throw new SourceError(`too many modules: ${paths.length} > ${MAX_MODULES}`);

  const contents = await repo.readFiles([DEPLOY_CONFIG_PATH, ...paths]);

  let config: DeployConfig;
  try {
    const parsed = DeployConfigSchema.safeParse(JSON.parse(contents[DEPLOY_CONFIG_PATH] ?? ""));
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    config = parsed.data;
  } catch (e) {
    throw new SourceError(`invalid ${DEPLOY_CONFIG_PATH}: ${String((e as Error).message ?? e)}`);
  }
  const main = config.main.replace(/^\.\//, "");
  if (!paths.includes(main)) throw new SourceError(`${DEPLOY_CONFIG_PATH} main "${config.main}" is not one of the uploaded src/**/*.js modules`);

  let total = 0;
  const modules: DeployModule[] = [];
  for (const path of paths) {
    const content = contents[path] ?? "";
    const size = bytes(content);
    if (size > MAX_MODULE_BYTES) throw new SourceError(`${path} is ${size} bytes (max ${MAX_MODULE_BYTES})`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new SourceError(`modules total more than ${MAX_TOTAL_BYTES} bytes`);
    modules.push({ name: path, contentType: JS_MODULE_TYPE, content });
  }
  return { mainModule: main, compatibilityDate: config.compatibility_date, modules, totalBytes: total };
}

// ── names ────────────────────────────────────────────────────────────────

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Parent Worker for a hive's deployments: `<hive>-app` (≤ 63 chars, lowercase DNS label). */
export function workerNameFor(hive: string): string {
  const slug = hive
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return `${slug || `h${fnv1a(hive)}`}-app`;
}

/**
 * Preview name for a train: `t-<12 hex>` (deploy-discovery §2), a lowercase DNS
 * label fragment. Uses the id's first 12 hex chars when it is UUID-like; any
 * other id gets a stable hash so distinct ids never collide on a shared prefix.
 */
export function previewNameFor(trainId: string): string {
  const alnum = trainId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^[0-9a-f]{12,}$/.test(alnum)) return `t-${alnum.slice(0, 12)}`;
  return `t-${fnv1a(trainId)}${fnv1a(`${trainId}:2`).slice(0, 4)}`;
}
