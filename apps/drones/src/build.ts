/**
 * Builder step bodies. Each runs inside ONE `step.do`: the in-memory clone
 * cannot cross steps, so clone → write → commit → note → push happen together
 * and only SHAs come back out (Workflows step results are capped at 1 MiB).
 */
import type { DroneTask, GitNotesPayload } from "@queenos/queen-types";
import { ledgerFilePath, serializeLedger } from "@queenos/hive-kit";
import { ChangeSetError, parseChangeSet, type ChangeSet } from "./change-set";
import type { DroneConfig } from "./config";
import type { DronePorts, GitSession } from "./ports";
import { BUILDER_SYSTEM_PROMPT, buildBuilderMessages } from "./prompt";
import { FEATURE_REGISTRY_PATH, SCRIPTED_MODEL, mergeRegistry, registryModules, scriptedChangeSet } from "./scripted";

export type LedgerStore = "git-notes" | "ledger-file";

export interface Generated {
  changeSet: ChangeSet;
  model: string;
  temperature: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** The AI step. Returns only the validated change set (well under 1 MiB). */
export async function generateChangeSet(task: DroneTask, ports: Pick<DronePorts, "llm">, config: DroneConfig): Promise<Generated> {
  if (config.llmMode === "scripted") {
    return { changeSet: scriptedChangeSet(task), model: SCRIPTED_MODEL, temperature: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  if (!ports.llm) throw new Error("UNAVAILABLE: no LLM port in live mode");
  const res = await ports.llm.complete({
    model: config.aiGateway.model,
    system: BUILDER_SYSTEM_PROMPT,
    messages: buildBuilderMessages(task),
    maxTokens: 16_000,
    ...(config.sendTemperature ? { temperature: config.temperature } : {}),
    metadata: { promptId: task.promptId, trainId: task.trainId, action: task.action },
  });
  if (res.finishReason === "length" || res.finishReason === "max_tokens") throw new ChangeSetError("model output was truncated (max_tokens)");
  return { changeSet: parseChangeSet(res.text), model: res.model, temperature: config.temperature, usage: res.usage ?? { inputTokens: 0, outputTokens: 0 } };
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
  const files = changeSet.files.map((f) => `- ${f.path}`).join("\n");
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
 * The change set only knows its own feature, but trains chain: merge the
 * template's feature registry with the one already on the branch so earlier
 * features stay registered.
 */
async function withMergedRegistry(repo: GitSession, files: ChangeSet["files"]): Promise<ChangeSet["files"]> {
  const entry = files.find((f) => f.path === FEATURE_REGISTRY_PATH);
  if (!entry) return files;
  const existing = (await repo.readFiles([FEATURE_REGISTRY_PATH]).catch(() => ({}) as Record<string, string>))[FEATURE_REGISTRY_PATH] ?? null;
  const merged = mergeRegistry(existing, registryModules(entry.content));
  return files.map((f) => (f === entry ? { ...f, content: merged } : f));
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
    await repo.writeFiles(await withMergedRegistry(repo, changeSet.files));
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
