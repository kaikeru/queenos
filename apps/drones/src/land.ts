/**
 * Lander step body. Artifacts has no merge API, so landing = pushing the
 * train head (task.baseRef) from the train fork to the hive repo's `main`
 * (the hive repo is named after the namespace; see apps/queen README).
 * A non-fast-forward is a clean "not landed", not an error.
 *
 * v2: for a merge-queue car the train fork is the car fork, and the ledger
 * notes are carried from the car fork AND every member fork (`task.members`),
 * because each builder wrote its notes on its own fork.
 */
import { LAND_DEPTH, type DroneTask } from "@queenos/queen-types";
import { NOTES_REF, type RemoteSpec } from "@queenos/hive-kit";
import type { DronePorts, GitSession } from "./ports";

/** History fetched from the fork; hive main must be within this many commits of the train head (queen-types). */
export { LAND_DEPTH };
export const LAND_REF = "refs/heads/queen-land";
const FORK_NOTES_REF = "refs/notes/queen-fork";
const HIVE_NOTES_REF = "refs/notes/queen-hive";
const SHA_RE = /^[0-9a-f]{40}$/;

export interface LandOutcome {
  landed: boolean;
  /** Hive main after the push (the train head) when landed. */
  mainSha?: string;
  summary: string;
  /** Ledger notes copied from the fork to the hive's refs/notes/queen. */
  notesCarried: number;
  notesError?: string;
}

const short = (sha: string) => sha.slice(0, 12);
const codeOf = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? "");

export async function landTrain(ports: Pick<DronePorts, "artifacts" | "git">, task: DroneTask, timestamp: number): Promise<LandOutcome> {
  const fork = await ports.artifacts.access(task.artifactRepo, "read");
  const hive = await ports.artifacts.access(task.namespace, "write");
  const repo = await ports.git.clone({ remote: fork.remote, token: fork.token, ref: "main", depth: LAND_DEPTH });

  const target = SHA_RE.test(task.baseRef) ? task.baseRef : await repo.resolveRef(task.baseRef);
  if (!(await repo.readCommit(target))) {
    return { landed: false, summary: `Train head ${short(target)} is not in fork ${task.artifactRepo}; nothing landed.`, notesCarried: 0 };
  }
  await repo.writeRef(LAND_REF, target);

  const hiveRemote: RemoteSpec = { url: hive.remote, token: hive.token };
  try {
    await repo.push({ ref: LAND_REF, remoteRef: "refs/heads/main", remote: hiveRemote });
  } catch (e) {
    const code = codeOf(e);
    if (code === "NOT_FAST_FORWARD" || code === "PUSH_REJECTED") {
      return {
        landed: false,
        summary: `${task.namespace}/main moved: pushing train head ${short(target)} was ${code === "NOT_FAST_FORWARD" ? "not a fast-forward" : "rejected"}.`,
        notesCarried: 0,
      };
    }
    throw e; // network/auth: let the step retry
  }

  const sources: RemoteSpec[] = [{ url: fork.remote, token: fork.token }];
  for (const m of task.members ?? []) {
    if (m.artifactRepo === task.artifactRepo) continue;
    const acc = await ports.artifacts.access(m.artifactRepo, "read");
    sources.push({ url: acc.remote, token: acc.token });
  }
  const notes = await carryNotes(repo, sources, hiveRemote, timestamp);
  return {
    landed: true,
    mainSha: target,
    summary: `Landed train ${task.trainId} at ${short(target)} on ${task.namespace}/main.`,
    ...notes,
  };
}

/**
 * Best effort: forks are created with defaultBranchOnly, so the builders'
 * notes live only on the train/member forks, which the Queen deletes after
 * landing. Copy them (in `forks` order) onto the hive's notes ref, then push
 * once. UNVERIFIED end-to-end on Artifacts.
 */
async function carryNotes(repo: GitSession, forks: RemoteSpec[], hive: RemoteSpec, timestamp: number): Promise<Pick<LandOutcome, "notesCarried" | "notesError">> {
  try {
    const collected: { target: string; text: string }[] = [];
    for (const [i, fork] of forks.entries()) {
      const localRef = `${FORK_NOTES_REF}-${i}`;
      if (!(await repo.fetchRef({ remoteRef: NOTES_REF, localRef, remote: fork, depth: 1 }))) continue;
      for (const n of await repo.listNotes(localRef)) {
        const text = await repo.readNote(n.target, localRef);
        if (text !== null) collected.push({ target: n.target, text });
      }
    }
    if (!collected.length) return { notesCarried: 0 };
    await repo.fetchRef({ remoteRef: NOTES_REF, localRef: HIVE_NOTES_REF, remote: hive, depth: 1 });
    for (const n of collected) await repo.addNote({ ref: HIVE_NOTES_REF, oid: n.target, note: n.text, timestamp });
    await repo.push({ ref: HIVE_NOTES_REF, remoteRef: NOTES_REF, remote: hive });
    return { notesCarried: collected.length };
  } catch (e) {
    const notesError = String((e as Error)?.message ?? e).slice(0, 300);
    console.warn("lander: could not carry ledger notes to the hive", notesError);
    return { notesCarried: 0, notesError };
  }
}
