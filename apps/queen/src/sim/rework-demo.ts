/**
 * Sim-only rework demo (rework-loop spec §11 "Sim mode", plan ruling R14): two agents, two items on one file. The first
 * lands. The second wins its race, conflicts in the merge queue (`[conflict-once]`), gets a conflict slot, syncs its
 * base (attemptSyncBase) and pushes a rebased head as the same candidate, which lands. It plays the agents through the
 * Queen's attempt RPCs, because the sim has no MCP server and no Artifacts.
 */
import type {
  AttemptBaseReady,
  AttemptIntent,
  AttemptIntentDecision,
  AttemptPushed,
  AttemptPushedResult,
  AttemptReady,
  AttemptResult,
  AttemptSyncBase,
  AttemptView,
  FileWorkItemInput,
  McpAgentIdentity,
  UpdateHiveSettings,
} from "@queenos/queen-types";
import { fakeSha } from "./sim-ports";

/** The QueenNode RPCs the demo calls (a DO stub fits it). */
export interface DemoQueen {
  updateSettings(input: { hive: string; user: string; patch: UpdateHiveSettings }): Promise<unknown>;
  fileWorkItem(input: { hive: string; user: string; item: FileWorkItemInput }): Promise<{ item: { itemId: string } }>;
  attemptIntent(input: AttemptIntent): Promise<AttemptIntentDecision>;
  attemptBaseReady(input: AttemptBaseReady): Promise<{ outcome: string }>;
  attemptReady(input: AttemptReady): Promise<AttemptResult>;
  attemptPushed(input: AttemptPushed): Promise<AttemptPushedResult>;
  getAttempt(attemptId: string): Promise<AttemptView | null>;
  attemptSyncBase(input: AttemptSyncBase): Promise<AttemptResult>;
}

const OWNER = "sim@example.com";

export async function reworkDemo(q: DemoQueen, hive: string, opts: { tick: () => Promise<void>; maxTicks?: number }): Promise<string[]> {
  const log: string[] = [];
  const say = (line: string) => log.push(line);
  await q.updateSettings({ hive, user: OWNER, patch: { executors: "external", race: { entryWindowMs: 0 } } as UpdateHiveSettings });
  const titles = ["Add a tip jar [touch:src/shared.js]", "Add a badge [touch:src/shared.js] [conflict-once]"];
  const agents: McpAgentIdentity[] = ["opus", "kimi"].map((name, i) => ({ agentId: `ag_${(i + 1).toString(16).padStart(32, "0")}`, name, model: "sim-model", role: "worker", owner: OWNER }));
  const attempts: { attemptId: string; repo: string; baseSha: string; agent: McpAgentIdentity }[] = [];
  for (const [i, title] of titles.entries()) {
    const { item } = await q.fileWorkItem({ hive, user: OWNER, item: { kind: "feature", title } });
    const d = await q.attemptIntent({ hive, owner: OWNER, agent: agents[i]!, target: { itemId: item.itemId } });
    if (d.verdict !== "accept") throw new Error(`rework demo: attempt refused: ${d.code} ${d.message}`);
    const baseSha = d.base.kind === "existing" ? d.base.baseSha : fakeSha(`base:${item.itemId}`);
    if (d.base.kind === "create") await q.attemptBaseReady({ hive, itemId: item.itemId, baseRepo: d.base.baseRepo, baseSha });
    const r = await q.attemptReady({ hive, attemptId: d.attemptId, repo: d.repo, baseSha, expiresAt: Date.now() + 7_200_000 });
    if (!r.ok) throw new Error(`rework demo: attempt not ready: ${r.code} ${r.message}`);
    attempts.push({ attemptId: d.attemptId, repo: d.repo, baseSha, agent: agents[i]! });
    say(`${agents[i]!.name}: attempt ${d.attemptId} READY on item ${item.itemId} "${title}"`);
  }
  const push = async (a: (typeof attempts)[number], n: number, title: string) => {
    const after = fakeSha(`demo:${a.attemptId}:${n}`);
    const r = await q.attemptPushed({ hive, attemptId: a.attemptId, repo: a.repo, before: n === 1 ? a.baseSha : fakeSha(`demo:${a.attemptId}:${n - 1}`), after, title, message: title });
    say(`${a.agent.name}: pushed ${after.slice(0, 7)} (${r.disposition ?? r.outcome}; train ${r.trainId ?? "?"})`);
  };
  const until = async (attemptId: string, done: (v: AttemptView) => boolean, what: string): Promise<AttemptView> => {
    for (let i = 0; i < (opts.maxTicks ?? 400); i++) {
      const v = await q.getAttempt(attemptId);
      if (v && done(v)) return v;
      await opts.tick();
    }
    throw new Error(`rework demo: timed out waiting for ${what}`);
  };
  const [first, second] = [attempts[0]!, attempts[1]!];
  await push(first, 1, "Add a tip jar");
  await until(first.attemptId, (v) => v.state === "LANDED", "the first attempt to land");
  say(`${first.agent.name}: ${first.attemptId} LANDED`);
  await push(second, 1, "Add a badge");
  const rejected = await until(second.attemptId, (v) => v.state === "REJECTED" && v.rework?.reason === "conflict", "the second winner's conflict slot");
  say(`${second.agent.name}: REJECTED (conflict in ${rejected.train?.conflict?.paths.join(", ") ?? "?"}); rework slot ${rejected.rework!.round} due ${new Date(rejected.rework!.dueAt).toISOString()}`);
  const main = fakeSha(`main:demo:${hive}`);
  const synced = await q.attemptSyncBase({ hive, attemptId: second.attemptId, owner: OWNER, agentId: second.agent.agentId, baseSha: main });
  if (!synced.ok) throw new Error(`rework demo: sync_base refused: ${synced.code} ${synced.message}`);
  say(`${second.agent.name}: sync_base → main@${main.slice(0, 7)}`);
  await push(second, 2, "Add a badge (rebased on main)");
  const landed = await until(second.attemptId, (v) => v.state === "LANDED", "the rebased head to land");
  say(`${second.agent.name}: rebased head ${landed.headSha?.slice(0, 7) ?? "?"} LANDED as the same candidate in race ${landed.raceId ?? "?"}`);
  return log;
}
