/** "Push code" panel logic (docs/human-push-design.md): git remote, instructions, token states. Pure; unit-tested. */
import type { GitToken } from "@queenos/queen-types";

import { ApiError } from "./api";

/** The hive's git remote through the edge: `https://<host>/git/<hive>`. */
export function gitRemote(origin: string, hive: string): string {
  return `${origin.replace(/\/+$/, "")}/git/${encodeURIComponent(hive)}`;
}

export interface Step {
  title: string;
  /** Shell lines, copied as one block. */
  cmd: string;
  note?: string;
}

/** Clone, branch, push and read the verdict notes. The token is never part of a command (git asks for it). */
export function pushSteps(origin: string, hive: string): Step[] {
  const remote = gitRemote(origin, hive);
  return [
    {
      title: "Clone",
      cmd: `git -c credential.helper='cache --timeout=3600' clone ${remote} ${hive}\ncd ${hive}`,
      note: "Username: anything. Password: your token. The credential cache keeps it in memory for an hour.",
    },
    {
      title: "Branch",
      cmd: "git switch -c item/<id>/<agent>   # join that item's race (item/<id> works too; agents sharing a token use <agent>)\n# or: git switch -c goal/<slug>   (a goal with one item)\n# any other branch name files a new item",
      note: "Pushing to main is refused: every push is a Submission the swarm vets.",
    },
    { title: "Push", cmd: "git push origin HEAD", note: "The remote: lines report the gate, the queue and the landing." },
    {
      title: "Read the verdict",
      cmd: "git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict",
    },
  ];
}

export type TokenState = "active" | "expired" | "revoked";

export function tokenState(t: Pick<GitToken, "revokedAt" | "expiresAt">, now: number): TokenState {
  if (t.revokedAt !== null) return "revoked";
  return t.expiresAt <= now ? "expired" : "active";
}

/** Active tokens first (newest first), then the rest (newest first). */
export function sortTokens(tokens: readonly GitToken[], now: number): GitToken[] {
  return [...tokens].sort((a, b) => Number(tokenState(a, now) !== "active") - Number(tokenState(b, now) !== "active") || b.createdAt - a.createdAt);
}

/**
 * The token API is absent here rather than failing: the sim runs without the edge (the Vite proxy has no
 * upstream), or an edge predates `/api/git-tokens`. Auth errors are NOT this: they need a sign-in.
 */
export function tokenApiUnavailable(e: unknown): boolean {
  return e instanceof ApiError && [0, 404, 500, 502, 503, 504].includes(e.status);
}
