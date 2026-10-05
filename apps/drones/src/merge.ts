/**
 * The MERGE drone's step body (v2 design §2.3.4): deterministic 3-way merges
 * of a car's members onto the car fork's `main`, then one push. No LLM.
 *
 * Idempotent: merge commits use the step's fixed timestamp, so a replayed
 * step makes the same SHAs and the push is a no-op. Infra failures (clone,
 * fetch, push errors) throw so the Workflow step retries; the caller
 * (orchestrate.ts `runMerge`) reports `ok: false` once retries run out.
 */
import { LAND_DEPTH, type DroneTask, type MergeConflict, type MergeMember, type MergeResultInput } from "@queenos/queen-types";
import { QUEEN_MERGE_IDENTITY, registryMergeDriver, type GitRepo, type GitMergeConflict, type RemoteSpec } from "@queenos/hive-kit";
import type { DronePorts, GitSession } from "./ports";

/** Local ref each member's head is fetched into. */
export const MEMBER_REF_PREFIX = "refs/queen/m/";

/** The GitRepo surface the MERGE drone needs beyond `GitSession`. */
export type MergeSession = GitSession & Pick<GitRepo, "merge" | "findMergeBase" | "changedPaths" | "deepen">;

function asMergeSession(s: GitSession): MergeSession {
  const m = s as Partial<MergeSession>;
  if (typeof m.merge !== "function" || typeof m.findMergeBase !== "function" || typeof m.changedPaths !== "function" || typeof m.deepen !== "function") {
    throw new Error("UNAVAILABLE: the git port's session cannot merge (needs hive-kit GitRepo merge/findMergeBase/changedPaths/deepen)");
  }
  return s as MergeSession;
}

const short = (sha: string) => sha.slice(0, 12);
const MAX_PATHS = 50;

/** `queue <carId>: merge <trainId> (<title>)` */
export function mergeMessage(carId: string, m: Pick<MergeMember, "trainId" | "title">): string {
  return `queue ${carId}: merge ${m.trainId} (${m.title})`;
}

function conflictSummary(kind: MergeConflict["kind"], why: string, paths: string[]): string {
  const where = paths.length ? `: ${paths.slice(0, 8).join(", ")}${paths.length > 8 ? ` (+${paths.length - 8} more)` : ""}` : "";
  return `Merge ${kind} (${why}) with work ahead of it in the queue${where}`.slice(0, 500);
}

function fromGit(trainId: string, c: GitMergeConflict): MergeConflict {
  const why =
    c.reason === "conflict" ? "both edit the same lines"
    : c.reason === "add-add" ? "both add the same path"
    : c.reason === "criss-cross" ? "criss-cross history, several merge bases"
    : c.reason === "no-merge-base" ? "no common history"
    : "file/type change isomorphic-git cannot merge";
  const paths = c.paths.slice(0, MAX_PATHS);
  return { trainId, kind: c.kind, paths, summary: conflictSummary(c.kind, why, paths) };
}

/**
 * Merge `task.members` (in order) onto the car fork `task.artifactRepo`'s main
 * and push it. Conflicting members are skipped and reported; `merged = []`
 * pushes nothing. `fastForward` = exactly one member whose head IS the car
 * head (its tree was already gated).
 */
export async function mergeCar(ports: Pick<DronePorts, "artifacts" | "git">, task: DroneTask, timestamp: number): Promise<MergeResultInput> {
  const t0 = Date.now();
  const members = task.members ?? [];
  const car = await ports.artifacts.access(task.artifactRepo, "write");
  const carRemote: RemoteSpec = { url: car.remote, token: car.token };
  const repo = asMergeSession(await ports.git.clone({ remote: car.remote, token: car.token, ref: "main", depth: LAND_DEPTH }));
  const baseSha = await repo.resolveRef("main");

  const merged: string[] = [];
  const conflicts: MergeConflict[] = [];
  let deepenedCar = false;

  for (const m of members) {
    const fork = await ports.artifacts.access(m.artifactRepo, "read");
    const forkRemote: RemoteSpec = { url: fork.remote, token: fork.token };
    const localRef = `${MEMBER_REF_PREFIX}${m.trainId}`;
    const fetched = await repo.fetchRef({ remoteRef: "refs/heads/main", localRef, remote: forkRemote, depth: LAND_DEPTH });
    if (!fetched || !(await repo.readCommit(m.headSha))) {
      conflicts.push({
        trainId: m.trainId,
        kind: "missing",
        paths: [],
        summary: `Head ${short(m.headSha)} is not on ${m.artifactRepo}/main (${fetched ? `main is ${short(fetched)}` : "no main"}); nothing to merge.`,
      });
      continue;
    }
    // Merge exactly the gated commit, even if the fork's main moved on.
    await repo.writeRef(localRef, m.headSha);

    if ((await repo.findMergeBase(["main", m.headSha])).length === 0) {
      // Shallow history: fetch everything once (template repos are small), then retry.
      if (!deepenedCar) {
        await repo.deepen({ remote: carRemote, remoteRef: "refs/heads/main" });
        deepenedCar = true;
      }
      await repo.deepen({ remote: forkRemote, remoteRef: "refs/heads/main", localRef });
      await repo.writeRef(localRef, m.headSha);
      // Still no base (unrelated history) → GitRepo.merge reports `unsupported`.
    }

    const out = await repo.merge({
      ours: "main",
      theirs: localRef,
      message: mergeMessage(task.trainId, m),
      timestamp,
      author: QUEEN_MERGE_IDENTITY,
      committer: QUEEN_MERGE_IDENTITY,
      mergeDriver: registryMergeDriver,
      fastForward: true,
    });
    if ("conflict" in out) conflicts.push(fromGit(m.trainId, out.conflict));
    else merged.push(m.trainId);
  }

  const headSha = await repo.resolveRef("main");
  if (headSha !== baseSha) await repo.push({ ref: "main", remoteRef: "refs/heads/main", remote: carRemote });
  const only = members.length === 1 && merged.length === 1 ? members[0] : undefined;
  const fastForward = !!only && headSha === only.headSha;

  const summary = merged.length
    ? `Merged ${merged.length}/${members.length} member(s) onto ${task.artifactRepo} at ${short(headSha)}${fastForward ? " (fast-forward)" : ""}${conflicts.length ? `; ${conflicts.length} conflict(s): ${conflicts.map((c) => `${c.trainId} (${c.kind})`).join(", ")}` : ""}.`
    : `No members merged onto ${task.artifactRepo}${conflicts.length ? `: ${conflicts.map((c) => `${c.trainId} (${c.kind})`).join(", ")}` : ""}.`;

  return {
    trainId: task.trainId,
    ok: true,
    headSha,
    baseSha,
    merged,
    conflicts,
    fastForward,
    mergeMs: Math.max(0, Date.now() - t0),
    summary: summary.slice(0, 500),
  };
}
