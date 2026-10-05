/**
 * Builder step bodies. Each runs inside ONE `step.do`: the in-memory clone
 * cannot cross steps, so clone → write → commit → note → push happen together
 * and only SHAs come back out (Workflows step results are capped at 1 MiB).
 */
import type { DroneTask, GitNotesPayload } from "@queenos/queen-types";
import { ledgerFilePath, serializeLedger } from "@queenos/hive-kit";
import type { ChangeSet } from "./change-set";
import type { DroneConfig } from "./config";
import type { DronePorts, GitSession } from "./ports";
import { generateLive, type Generated } from "./generate";
import { gatherRepoContext } from "./repo-context";
import { FEATURE_REGISTRY_PATH, SCRIPTED_MODEL, featureModuleName, registryModules, renderRegistry, scriptedChangeSet } from "./scripted";

export type LedgerStore = "git-notes" | "ledger-file";

export type { Generated } from "./generate";

/** The AI step. Returns only the validated change set (well under 1 MiB). */
export async function generateChangeSet(
  task: DroneTask,
  ports: Pick<DronePorts, "llm" | "artifacts" | "git">,
  config: DroneConfig,
): Promise<Generated> {
  if (config.llmMode === "scripted") {
    return { changeSet: scriptedChangeSet(task), model: SCRIPTED_MODEL, failedModels: [], repaired: false, temperature: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  if (!ports.llm) throw new Error("UNAVAILABLE: no LLM port in live mode");
  const context = await gatherRepoContext(task, branchOf(task.baseRef), ports);
  return generateLive({ llm: ports.llm, task, config, context });
}

/** Marks every commit a drone makes, so a retried step can recognise its own pushed work. */
export function droneTrailer(task: Pick<DroneTask, "trainId" | "promptId" | "action">): string {
  return `Queen-Drone: ${task.trainId}/${task.promptId}/${task.action}`;
}

const LEDGER_FOR_RE = /^Queen-Ledger-For: ([0-9a-f]{40})$/m;
const SHA_RE = /^[0-9a-f]{40}$/;

/** Branch the builder commits to: `baseRef` if it names a branch, else main. */
export function branchOf(baseRef: string): string {
  if (SHA_RE.test(baseRef)) return "main";
  return baseRef.replace(/^refs\/heads\//, "");
}

export function commitMessage(task: DroneTask, changeSet: ChangeSet): string {
  const first = (task.promptText.split("\n").find((l) => l.trim()) ?? "change").trim();
  const subject = `queen(${task.action.toLowerCase()}): ${first.length > 60 ? `${first.slice(0, 59)}…` : first}`;
  const files = [...changeSet.files.map((f) => `- ${f.path}`), ...(changeSet.deletes ?? []).map((p) => `- ${p} (deleted)`)].join("\n");
  return `${subject}\n\n${files}\n\nQueen-Prompt: ${task.promptId}\nQueen-Train: ${task.trainId}\n${droneTrailer(task)}\n`;
}

export interface CommitPushInput {
  task: DroneTask;
  changeSet: ChangeSet;
  ledger: GitNotesPayload;
  /** Unix seconds, fixed by an earlier step so retries produce the same SHAs. */
  timestamp: number;
}

export interface CommitPushResult {
  /** Tip of the fork's branch after the push (what the Queen should test). */
  headSha: string;
  /** The commit carrying the code change (the ledger is keyed by it). */
  codeSha: string;
  ledgerStore: LedgerStore;
  /** Why the notes push failed, when the fallback was used. */
  notesError?: string;
  /** True if an earlier attempt had already pushed the code commit. */
  resumed: boolean;
}

/**
 * The change set only knows its own feature, but trains chain: merge the template's feature registry
 * with the one already on the branch so earlier features stay registered. Works for live output too:
 * the registry is re-rendered in the canonical shape from whatever modules the model's registry
 * imports PLUS every new `src/features/<name>.js` the change set adds (a model that forgot to
 * register its module still ships a working feature).
 */
export async function withMergedRegistry(
  repo: Pick<GitSession, "readFiles">,
  files: ChangeSet["files"],
  deletes: readonly string[] = [],
): Promise<ChangeSet["files"]> {
  const entry = files.find((f) => f.path === FEATURE_REGISTRY_PATH);
  const added = files.flatMap((f) => {
    const m = featureModuleName(f.path);
    return m ? [m] : [];
  });
  const removed = new Set(deletes.flatMap((p) => featureModuleName(p) ?? []));
  if (!entry && added.length === 0 && removed.size === 0) return files;
  const existing = (await repo.readFiles([FEATURE_REGISTRY_PATH]).catch(() => ({}) as Record<string, string>))[FEATURE_REGISTRY_PATH] ?? null;
  if (existing === null && !entry && added.length === 0) return files;
  const merged = renderRegistry(
    [...registryModules(existing ?? ""), ...(entry ? registryModules(entry.content) : []), ...added].filter((m) => !removed.has(m)),
  );
  return entry ? files.map((f) => (f === entry ? { ...f, content: merged } : f)) : [...files, { path: FEATURE_REGISTRY_PATH, content: merged }];
}

export async function commitAndPush(ports: Pick<DronePorts, "artifacts" | "git">, input: CommitPushInput): Promise<CommitPushResult> {
  const { task, changeSet, ledger, timestamp } = input;
  // Token is minted inside this step and never returned: it must not land in step state.
  const access = await ports.artifacts.access(task.artifactRepo, "write");
  const branch = branchOf(task.baseRef);
  const repo = await ports.git.clone({ remote: access.remote, token: access.token, ref: branch, depth: 1 });
  const marker = droneTrailer(task);

  let codeSha: string;
  let resumed = false;
  const head = await repo.head();
  if (head?.message.includes(marker)) {
    // A previous attempt already pushed. If it also pushed the ledger-file fallback, we are done.
    resumed = true;
    const ledgerFor = LEDGER_FOR_RE.exec(head.message)?.[1];
    if (ledgerFor) return { headSha: head.oid, codeSha: ledgerFor, ledgerStore: "ledger-file", resumed };
    codeSha = head.oid;
  } else {
    const deletes = changeSet.deletes ?? [];
    await repo.writeFiles([...(await withMergedRegistry(repo, changeSet.files, deletes)), ...deletes.map((path) => ({ path, delete: true as const }))]);
    codeSha = await repo.commitAll({ message: commitMessage(task, changeSet), timestamp });
  }

  const note = serializeLedger(ledger);
  await repo.addNote({ oid: codeSha, note, timestamp });
  if (!resumed) await repo.push({ ref: branch });

  try {
    await repo.pushNotes();
    return { headSha: codeSha, codeSha, ledgerStore: "git-notes", resumed };
  } catch (e) {
    // UNVERIFIED whether Artifacts accepts refs/notes/*: fall back to an in-tree ledger file.
    const notesError = String((e as Error)?.message ?? e).slice(0, 300);
    console.warn(`drone: notes push failed for ${task.artifactRepo}; writing ${ledgerFilePath(codeSha)}`, notesError);
    await repo.writeFiles([{ path: ledgerFilePath(codeSha), content: note }]);
    const ledgerSha = await repo.commitAll({
      message: `queen(ledger): cognitive ledger for ${codeSha.slice(0, 12)}\n\nQueen-Ledger-For: ${codeSha}\n${marker}\n`,
      timestamp,
    });
    await repo.push({ ref: branch });
    return { headSha: ledgerSha, codeSha, ledgerStore: "ledger-file", notesError, resumed };
  }
}
