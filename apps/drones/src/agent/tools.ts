/**
 * The drone's own tools for the BuilderAgent (Think supplies read/write/edit/list/find/grep/delete):
 * - verify: run the edited Worker in a Dynamic Worker and probe its routes;
 * - finish: end the task, refused unless the last edit was verified and nothing platform-owned changed.
 *
 * Tool state lives behind `ToolStateStore` (DO SQLite in production) so a turn recovered after an
 * eviction still knows what was verified.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { diffTrees, overlayProblems, snapshotHash } from "./overlay";
import { MAX_VERIFY_PATHS, verifyWorker, type LoaderLike, type VerifyResult } from "./verify";

export const MAX_VERIFY_CALLS = 6;

/** Max out-of-scope problems a build may file (the Queen's guardrail clamps further). */
export const MAX_FOLLOW_UPS = 3;

/** A problem outside the task that the builder noticed while working (never its own unfinished work). */
export interface FinishFollowUp {
  kind: "bug" | "chore";
  title: string;
  body: string;
  paths?: string[] | undefined;
  priority?: number | undefined;
}

export interface FinishArgs {
  summary: string;
  reasoningSteps: string[];
  discardedPaths: string[];
  followUps?: FinishFollowUp[] | undefined;
}

export interface ToolState {
  verifyCalls: number;
  /** Snapshot hash of the last passing verify. */
  lastPassHash: string | null;
  lastVerify: VerifyResult | null;
  /** Set once finish is accepted; ends the turn. */
  finish: FinishArgs | null;
}

export const EMPTY_TOOL_STATE: ToolState = { verifyCalls: 0, lastPassHash: null, lastVerify: null, finish: null };

export interface ToolStateStore {
  get(): ToolState;
  put(s: ToolState): void;
}

export interface DroneToolDeps {
  /** Current workspace, repo-relative paths. */
  snapshot(): Promise<Record<string, string>>;
  /** The seeded base tree. */
  base(): Record<string, string>;
  loader: LoaderLike | undefined;
  state: ToolStateStore;
}

export const FinishInputSchema = z.object({
  summary: z.string().min(1).max(500).describe("What you changed, in one or two sentences."),
  reasoningSteps: z.array(z.string().max(300)).min(1).max(6).describe("2-6 short steps: what you found and why you changed what you changed."),
  discardedPaths: z.array(z.string().max(200)).max(10).default([]).describe("Approaches you considered and rejected (may be empty)."),
  followUps: z
    .array(
      z.object({
        kind: z.enum(["bug", "chore"]),
        title: z.string().min(1).max(120),
        body: z.string().max(1000).describe("What is wrong, where, and how you saw it."),
        paths: z.array(z.string().max(200)).max(10).default([]),
        priority: z.number().int().min(1).max(3).default(2).describe("1 = urgent, 3 = low."),
      }),
    )
    .max(MAX_FOLLOW_UPS)
    .default([])
    .describe("At most 3 real problems OUTSIDE your task that you noticed (may be empty). Never your own unfinished work."),
});

export async function runVerify(deps: DroneToolDeps, paths: string[] | undefined): Promise<VerifyResult | { ok: false; error: string }> {
  const s = deps.state.get();
  if (s.verifyCalls >= MAX_VERIFY_CALLS) {
    return { ok: false, error: `verify budget exhausted (${MAX_VERIFY_CALLS} calls). Finish only if the last verify passed and you have not edited since.` };
  }
  const files = await deps.snapshot();
  const changed = diffTrees(deps.base(), files);
  const r = await verifyWorker(deps.loader, { files, changed, ...(paths ? { paths } : {}) });
  deps.state.put({ ...s, verifyCalls: s.verifyCalls + 1, lastVerify: r, lastPassHash: r.ok ? snapshotHash(files) : s.lastPassHash });
  return r;
}

export async function runFinish(deps: DroneToolDeps, args: FinishArgs): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = deps.state.get();
  if (s.finish) return { ok: true };
  const files = await deps.snapshot();
  const problems = overlayProblems(diffTrees(deps.base(), files));
  if (problems.length) return { ok: false, error: `finish refused: ${problems.join("; ")}` };
  if (s.lastPassHash !== snapshotHash(files)) {
    return { ok: false, error: "finish refused: call verify after your last edit and make sure it passes, then finish." };
  }
  deps.state.put({ ...s, finish: args });
  return { ok: true };
}

export function droneTools(deps: DroneToolDeps): ToolSet {
  return {
    verify: tool({
      description:
        'Load the current workspace as a Worker in an isolated sandbox (no network) and GET "/", "/health" and any extra paths. Returns status, content-type and the start of each body, plus template problems. ok=false means something must be fixed.',
      inputSchema: z.object({
        paths: z.array(z.string().max(200)).max(MAX_VERIFY_PATHS).optional().describe('Extra paths to GET, e.g. ["/status"]'),
      }),
      execute: async ({ paths }) => runVerify(deps, paths),
    }),
    finish: tool({
      description: "Call exactly once when the change is done and the last verify (after your final edit) passed. Ends the task.",
      inputSchema: FinishInputSchema,
      execute: async (args) => runFinish(deps, { ...args, discardedPaths: args.discardedPaths ?? [], followUps: args.followUps ?? [] }),
    }),
  };
}
