/** Reads the grounding context for the live builder from the cloned train repo. */
import type { DroneTask } from "@queenos/queen-types";
import type { DronePorts } from "./ports";
import { CONTEXT_KEY_FILES, MAX_CONTEXT_FILE_CHARS, type RepoContext } from "./prompt";

const clipText = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n… [truncated]`);

/**
 * File list plus the key files (registry, router, deploy.json) and one existing feature module as a
 * style example. Best effort: on any failure returns null and the prompt falls back to the template
 * shapes described in the system prompt.
 */
export async function gatherRepoContext(task: DroneTask, ref: string, ports: Pick<DronePorts, "artifacts" | "git">): Promise<RepoContext | null> {
  try {
    const access = await ports.artifacts.access(task.artifactRepo, "read");
    const repo = await ports.git.clone({ remote: access.remote, token: access.token, ref, depth: 1 });
    const files = (await repo.listFiles()).filter((f) => !f.startsWith(".git/") && !f.startsWith("node_modules/")).sort();
    const example = files.find((f) => /^src\/features\/(?!index\.js$)[^/]+\.js$/.test(f));
    const wanted = [...CONTEXT_KEY_FILES, ...(example ? [example] : [])].filter((f) => files.includes(f));
    const read = wanted.length ? await repo.readFiles(wanted) : {};
    const key: Record<string, string> = {};
    for (const f of wanted) if (typeof read[f] === "string") key[f] = clipText(read[f]!, MAX_CONTEXT_FILE_CHARS);
    return { files, key };
  } catch (e) {
    console.warn(`drone: could not read repo context for ${task.artifactRepo}; using template defaults`, String((e as Error)?.message ?? e).slice(0, 200));
    return null;
  }
}
