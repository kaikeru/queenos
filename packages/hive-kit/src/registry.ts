/**
 * The template's generated feature registry (templates/worker-starter):
 * `src/features/index.js`, one namespace import per feature module. Every
 * feature build appends a line to it, so the merge queue resolves it with
 * `registryMergeDriver` (merge-driver.ts) instead of a textual diff3 merge.
 *
 * Moved from apps/drones/src/scripted.ts (behaviour-preserving); the drones
 * re-export it from there.
 */
import { GENERATED_PATHS } from "@queenos/queen-types";

/** The registry path (the only GENERATED_PATHS entry today). */
export const FEATURE_REGISTRY_PATH: (typeof GENERATED_PATHS)[number] = GENERATED_PATHS[0];

/**
 * The registry's first line. It is a `//` comment, which the merge driver accepts, so hives created with an older header still merge.
 * The wording tells an agent the file IS meant to be edited, in exactly this shape.
 */
export const REGISTRY_HEADER = `// Feature registry. Keep this exact shape: one 'import * as fN from "./<file>.js";' per feature module, then "export const features = [...]". QueenOS merges it line by line.`;

/** One namespace import per feature module, sorted and deduplicated so the output is deterministic. */
export function renderRegistry(modules: readonly string[]): string {
  const files = [...new Set(modules)].sort();
  return [
    REGISTRY_HEADER,
    ...files.map((f, i) => `import * as f${i} from "./${f}";`),
    `export const features = [${files.map((_, i) => `f${i}`).join(", ")}];`,
    "",
  ].join("\n");
}

/** Module files (`<name>.js`) a registry imports (any quote style, namespace/default/named imports). */
export function registryModules(registry: string): string[] {
  return [...registry.matchAll(/from\s*["']\.\/([A-Za-z0-9._-]+\.js)["']/g)].map((m) => m[1]!).filter((f) => f !== "index.js");
}

/** `<name>.js` for a feature module path (`src/features/<name>.js`, not the registry), else null. */
export function featureModuleName(path: string): string | null {
  const m = /^src\/features\/([A-Za-z0-9._-]+\.js)$/.exec(path);
  return m && m[1] !== "index.js" ? m[1]! : null;
}

/**
 * Add `modules` to an existing registry (null = none yet). The change set only
 * knows its own feature; this keeps every earlier feature.
 */
export function mergeRegistry(existing: string | null | undefined, modules: readonly string[]): string {
  return renderRegistry([...registryModules(existing ?? ""), ...modules]);
}
