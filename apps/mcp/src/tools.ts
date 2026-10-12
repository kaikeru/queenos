/**
 * The MCP tools (spec §6). Each takes and returns JSON; errors are `{code, message}` (spec §11). Every tool except
 * whoami / init_agent / resume_agent needs the session's agent ("call init_agent first"). Never log a tool result:
 * start_attempt and refresh_attempt return an attempt token.
 */
import { z } from "zod";
import {
  ATTEMPT_TOKEN_TTL_S,
  AgentHandleSchema,
  AgentIdSchema,
  AgentRoleSchema,
  AttemptIdSchema,
  ClaimedModelSchema,
  ENTRY_WINDOW_MAX_MS,
  HiveSlugSchema,
  WAIT_MAX_MS,
  WorkStatusSchema,
  isTerminalAttemptState,
  type AttemptState,
  type AttemptVerdict,
  type AttemptView,
  type GoalChild,
  type McpAgentIdentity,
  type McpErrorCode,
  type Race,
} from "@queenos/queen-types";
import { attemptDir, cleanupOf, configCommand } from "./commands";
import { ToolError, artifactsUnavailable, fromQueen } from "./errors";
import type { McpPorts } from "./ports";
import { openAttempts, startAttempt } from "./start";

export interface SessionPort {
  /** The edge-derived owner this session is bound to. */
  owner(): string;
  identity(): McpAgentIdentity | null;
  bind(identity: McpAgentIdentity): Promise<void>;
}

export interface ToolCtx {
  ports: McpPorts;
  session: SessionPort;
}

export interface ToolSpec {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** `args` is the shape-validated input; each tool declares its own parameter type (`never` accepts any of them). */
  run(ctx: ToolCtx, args: never): Promise<unknown>;
}

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: { code: McpErrorCode; message: string; items?: GoalChild[] } };

export const WAIT_POLL_MS = 2_000;
const ItemIdSchema = z.string().min(1).max(64);

/** Validate (field names only in the message), run, and turn any failure into `{code, message}`. */
export async function callTool(spec: ToolSpec, ctx: ToolCtx, raw: unknown): Promise<ToolOutcome> {
  const parsed = z.object(spec.shape).safeParse(raw ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(input)"))].join(", ");
    return { ok: false, error: { code: "INVALID_INPUT", message: `invalid ${fields}`.slice(0, 200) } };
  }
  try {
    return { ok: true, value: await spec.run(ctx, parsed.data as never) };
  } catch (e) {
    const t = e instanceof ToolError ? e : fromQueen(e);
    return { ok: false, error: { code: t.code, message: t.message, ...(t.items ? { items: t.items } : {}) } };
  }
}

/** The session's agent; NOT_INITIALIZED before init_agent / resume_agent. */
export function agentOf(ctx: ToolCtx): McpAgentIdentity {
  const id = ctx.session.identity();
  if (!id) throw new ToolError("NOT_INITIALIZED", "call init_agent first (or resume_agent after a reconnect)");
  if (id.owner !== ctx.session.owner()) throw new ToolError("FORBIDDEN_OWNER", "this session's agent belongs to another owner");
  return id;
}

/** An attempt of the session's agent (its AgentIdentity knows the hive); any other attempt is FORBIDDEN_OWNER. */
async function ownAttempt(ctx: ToolCtx, agent: McpAgentIdentity, attemptId: string): Promise<{ hive: string; view: AttemptView }> {
  const ref = (await ctx.ports.identity(agent.agentId).attempts()).find((a) => a.attemptId === attemptId);
  if (!ref) throw new ToolError("FORBIDDEN_OWNER", `attempt ${attemptId} is not one of this agent's attempts`);
  const view = await ctx.ports.queen(ref.hive).getAttempt(attemptId);
  if (!view) throw new ToolError("NOT_FOUND", `attempt ${attemptId} not found`);
  if (isTerminalAttemptState(view.state)) await ctx.ports.identity(agent.agentId).closeAttempt(attemptId);
  return { hive: ref.hive, view };
}

async function requireHive(ctx: ToolCtx, hive: string): Promise<void> {
  if (!(await ctx.ports.registry.get(hive))) throw new ToolError("NOT_FOUND", `hive ${hive} not found`);
}

const withCleanup = (v: AttemptView) => (isTerminalAttemptState(v.state) ? { ...v, cleanup: cleanupOf(v.attemptId) } : v);

/** `wait` on an attempt: verdict = its head PASSED / REJECTED (or WON); decided = WON / LOST; landed = LANDED. Any terminal state ends every wait. */
export function attemptReached(state: AttemptState, until: "verdict" | "decided" | "landed"): boolean {
  if (isTerminalAttemptState(state)) return true;
  if (until === "verdict") return state === "PASSED" || state === "REJECTED" || state === "WON";
  if (until === "decided") return state === "WON";
  return false;
}

/** `wait` on an item: verdict = a candidate has a verdict; decided = its race is DECIDED / ABANDONED; landed = the item is done. */
export function itemReached(status: string, race: Pick<Race, "state"> | null, verdicts: AttemptVerdict[], until: "verdict" | "decided" | "landed"): boolean {
  if (["LANDED", "SHIPPED", "CANCELLED", "DUPLICATE"].includes(status)) return true;
  if (until === "verdict") return verdicts.some((v) => v === "passed" || v === "rejected");
  if (until === "decided") return !!race && (race.state === "DECIDED" || race.state === "ABANDONED");
  return false;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "whoami",
    description: "The human this session acts for, and the bound agent (null before init_agent). Needs no init.",
    shape: {},
    run: async (ctx) => {
      const a = ctx.session.identity();
      return { owner: ctx.session.owner(), agent: a ? { agentId: a.agentId, name: a.name, model: a.model, role: a.role } : null };
    },
  },
  {
    name: "init_agent",
    description: "Bind this session to a new agent. name: a ref-safe handle; model: what you run on (self-reported, shown as 'claims'); role: orchestrator (files goals) or worker. Keep the agentId: after a reconnect, call resume_agent.",
    shape: { name: AgentHandleSchema, model: ClaimedModelSchema, role: AgentRoleSchema },
    run: async (ctx, a: { name: string; model: string; role: "orchestrator" | "worker" }) => {
      if (ctx.session.identity()) throw new ToolError("ALREADY_INITIALIZED", "this session already has an agent; open a new session for another agent");
      const identity: McpAgentIdentity = { agentId: ctx.ports.newAgentId(), name: a.name, model: a.model, role: a.role, owner: ctx.session.owner() };
      const stored = await ctx.ports.identity(identity.agentId).create(identity);
      await ctx.session.bind(stored);
      return stored;
    },
  },
  {
    name: "resume_agent",
    description: "Re-bind this (new) session to an agent created earlier by the same human, e.g. after a reconnect.",
    shape: { agentId: AgentIdSchema },
    run: async (ctx, a: { agentId: string }) => {
      const port = ctx.ports.identity(a.agentId);
      const identity = await port.get();
      if (!identity) throw new ToolError("NOT_FOUND", `agent ${a.agentId} not found`);
      if (identity.owner !== ctx.session.owner()) throw new ToolError("FORBIDDEN_OWNER", "that agent belongs to another owner");
      const cur = ctx.session.identity();
      if (cur && cur.agentId !== identity.agentId) throw new ToolError("ALREADY_INITIALIZED", "this session already has another agent");
      await ctx.session.bind(identity);
      const openAttempts = (await port.attempts()).filter((r) => r.open).map((r) => ({ hive: r.hive, attemptId: r.attemptId }));
      return { ...identity, openAttempts };
    },
  },
  {
    name: "list_hives",
    description: "The hives (projects) of this QueenOS.",
    shape: {},
    run: async (ctx) => {
      agentOf(ctx);
      return (await ctx.ports.registry.list()).map((p) => ({ hive: p.hive, name: p.name, status: p.status }));
    },
  },
  {
    name: "create_goal",
    description: "Orchestrators only: file a goal in an external hive. It becomes one item agents race on. judge: auto (the Queen ranks) or pick (a human picks). entryWindowMs: how long the race takes entries after its first push (max 1 h).",
    shape: {
      hive: HiveSlugSchema,
      title: z.string().min(1).max(120),
      description: z.string().max(4000),
      judge: z.enum(["auto", "pick"]).optional(),
      entryWindowMs: z.number().int().min(0).max(ENTRY_WINDOW_MAX_MS).optional(),
    },
    run: async (ctx, a: { hive: string; title: string; description: string; judge?: "auto" | "pick"; entryWindowMs?: number }) => {
      const agent = agentOf(ctx);
      if (agent.role !== "orchestrator") throw new ToolError("FORBIDDEN_ROLE", "create_goal is for orchestrator agents");
      await requireHive(ctx, a.hive);
      const queen = ctx.ports.queen(a.hive);
      const status = await queen.hiveStatus();
      if (!status) throw new ToolError("NOT_FOUND", `hive ${a.hive} not found`);
      if (status.settings.executors !== "external") throw new ToolError("HIVE_NOT_EXTERNAL", `hive ${a.hive} runs its own swarm; agent goals need an external hive`);
      const { item: goal } = await queen.submitWork({
        namespace: a.hive,
        promptText: a.description ? `${a.title}\n\n${a.description}` : a.title,
        decompose: true,
        ...(a.judge ? { judge: a.judge === "pick" ? "human" : "auto" } : {}),
        ...(a.entryWindowMs !== undefined ? { entryWindowMs: a.entryWindowMs } : {}),
        user: agent.owner,
      });
      const detail = await queen.getItemDetail(goal.itemId);
      return { goalId: goal.itemId, itemId: detail.children[0]?.itemId ?? null };
    },
  },
  {
    name: "list_items",
    description: "A hive's items (open ones and recent closed ones), optionally of one status.",
    shape: { hive: HiveSlugSchema, state: WorkStatusSchema.optional() },
    run: async (ctx, a: { hive: string; state?: string }) => {
      agentOf(ctx);
      await requireHive(ctx, a.hive);
      const snap = await ctx.ports.queen(a.hive).getSnapshot();
      return (snap.items ?? [])
        .filter((i) => a.state === undefined || i.status === a.state)
        .map((i) => ({ itemId: i.itemId, title: i.title, kind: i.kind, status: i.status, waitReason: i.waitReason ?? null, parentId: i.parentId }));
    },
  },
  {
    name: "get_item",
    description: "One item and its race: state, shared base commit, entry window and candidates (attempt, agent, claimed model, verdict, preview).",
    shape: { hive: HiveSlugSchema, itemId: ItemIdSchema },
    run: async (ctx, a: { hive: string; itemId: string }) => {
      agentOf(ctx);
      const queen = ctx.ports.queen(a.hive);
      const [detail, atts] = await Promise.all([queen.getItemDetail(a.itemId), queen.attemptsForItem(a.itemId)]);
      const race = detail.races.at(-1) ?? null;
      return {
        item: detail.item,
        race: race
          ? {
              raceId: race.raceId,
              state: race.state,
              baseSha: atts.baseSha,
              entryClosesAt: race.entryClosesAt ?? null,
              candidates: atts.attempts
                .filter((x) => race.trainIds.includes(x.trainId))
                .map((x) => ({ attemptId: x.attemptId, agent: x.agentName, claimedModel: x.model, verdict: x.verdict, previewUrl: x.train?.previewUrl ?? null })),
            }
          : null,
      };
    },
  },
  {
    name: "start_attempt",
    description:
      "Start an attempt on an item (or a goal with one open item): you get your own fork of the item's frozen base and a 2 h token for it. Run cloneCommand then configCommand, commit, `git push origin main`. Can take up to a minute.",
    shape: { hive: HiveSlugSchema, itemId: ItemIdSchema.optional(), goalId: ItemIdSchema.optional() },
    run: async (ctx, a: { hive: string; itemId?: string; goalId?: string }) => {
      const agent = agentOf(ctx);
      if ((a.itemId === undefined) === (a.goalId === undefined)) throw new ToolError("INVALID_INPUT", "give exactly one of itemId, goalId");
      await requireHive(ctx, a.hive);
      return startAttempt(ctx.ports, agent, a);
    },
  },
  {
    name: "refresh_attempt",
    description: "Your attempt: a fresh 2 h token (older tokens of the fork are revoked). Run the returned configCommand.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }) => {
      const agent = agentOf(ctx);
      const { hive } = await ownAttempt(ctx, agent, a.attemptId);
      const r = await ctx.ports.queen(hive).attemptRefresh({ hive, attemptId: a.attemptId, owner: agent.owner, agentId: agent.agentId });
      if (!r.ok) throw new ToolError(r.code, r.message);
      try {
        using h = await ctx.ports.artifacts.get(r.attempt.repo);
        const [info, tok] = await Promise.all([h.info(), h.createToken("write", ATTEMPT_TOKEN_TTL_S)]);
        for (const t of (await h.listTokens()).tokens) if (t.id !== tok.id && t.state === "active") await h.revokeToken(t.id);
        const remote = info.remote.replace(/\/+$/, "");
        return { token: tok.plaintext, expiresAt: Date.parse(tok.expiresAt) || r.attempt.expiresAt, configCommand: configCommand(remote, tok.plaintext, attemptDir(a.attemptId)) };
      } catch (e) {
        throw artifactsUnavailable("token refresh", e);
      }
    },
  },
  {
    name: "end_attempt",
    description: "End your attempt (withdraws it unless it already boarded the merge queue). Then remove its local folder.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }) => {
      const agent = agentOf(ctx);
      const { hive } = await ownAttempt(ctx, agent, a.attemptId);
      const r = await ctx.ports.queen(hive).attemptEnd({ hive, attemptId: a.attemptId, owner: agent.owner, agentId: agent.agentId });
      if (!r.ok) throw new ToolError(r.code, r.message);
      if (isTerminalAttemptState(r.attempt.state)) await ctx.ports.identity(agent.agentId).closeAttempt(a.attemptId);
      return { state: r.attempt.state, cleanup: cleanupOf(a.attemptId) };
    },
  },
  {
    name: "get_attempt",
    description: "Your attempt: state, current train, race and verdict summary.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }) => withCleanup((await ownAttempt(ctx, agentOf(ctx), a.attemptId)).view),
  },
  {
    name: "list_attempts",
    description: "Your attempts in every hive (newest 50).",
    shape: {},
    run: async (ctx) => {
      const agent = agentOf(ctx);
      const refs = (await ctx.ports.identity(agent.agentId).attempts()).slice(-50).reverse();
      const out: unknown[] = [];
      for (const r of refs) {
        const v = await ctx.ports.queen(r.hive).getAttempt(r.attemptId);
        if (v) out.push(withCleanup(v));
      }
      await openAttempts(ctx.ports, agent); // prunes terminal ones from the agent's open list
      return out;
    },
  },
  {
    name: "wait",
    description: `Long-poll (at most ${WAIT_MAX_MS} ms) until your attempt (attemptId) or an item (hive + itemId) reaches: verdict, decided or landed. On timeout returns changed:false; call again.`,
    shape: {
      attemptId: AttemptIdSchema.optional(),
      hive: HiveSlugSchema.optional(),
      itemId: ItemIdSchema.optional(),
      until: z.enum(["verdict", "decided", "landed"]),
      timeoutMs: z.number().int().min(0).max(WAIT_MAX_MS).optional(),
    },
    run: async (ctx, a: { attemptId?: string; hive?: string; itemId?: string; until: "verdict" | "decided" | "landed"; timeoutMs?: number }) => {
      const agent = agentOf(ctx);
      const byAttempt = a.attemptId !== undefined;
      if (byAttempt === (a.itemId !== undefined) || (!byAttempt && a.hive === undefined)) throw new ToolError("INVALID_INPUT", "give attemptId, or hive and itemId");
      const timeout = Math.min(a.timeoutMs ?? WAIT_MAX_MS, WAIT_MAX_MS);
      const start = ctx.ports.now();
      const own = byAttempt ? await ownAttempt(ctx, agent, a.attemptId!) : null;
      const queen = ctx.ports.queen(own?.hive ?? a.hive!);
      for (;;) {
        let done: boolean;
        let result: Record<string, unknown>;
        if (own) {
          const view = await queen.getAttempt(a.attemptId!);
          if (!view) throw new ToolError("NOT_FOUND", `attempt ${a.attemptId} not found`);
          done = attemptReached(view.state, a.until);
          result = { state: view.state, attempt: withCleanup(view) };
        } else {
          const [detail, atts] = await Promise.all([queen.getItemDetail(a.itemId!), queen.attemptsForItem(a.itemId!)]);
          const race = detail.races.at(-1) ?? null;
          done = itemReached(detail.item.status, race, atts.attempts.map((x) => x.verdict), a.until);
          result = {
            state: detail.item.status,
            item: { itemId: detail.item.itemId, status: detail.item.status, waitReason: detail.item.waitReason ?? null, race: race ? { raceId: race.raceId, state: race.state, entryClosesAt: race.entryClosesAt ?? null, winnerTrainId: race.winnerTrainId } : null },
          };
        }
        if (done) return { changed: true, ...result };
        if (ctx.ports.now() - start + WAIT_POLL_MS > timeout) return { changed: false, ...result };
        await ctx.ports.sleep(WAIT_POLL_MS);
      }
    },
  },
  {
    name: "get_verdict",
    description: "Your attempt's verdict on its current head: the v1 verdict note (as on refs/notes/verdict), findings and the preview URL.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }) => {
      const { hive, view } = await ownAttempt(ctx, agentOf(ctx), a.attemptId);
      const note = view.headSha ? await ctx.ports.queen(hive).verdictNote(view.headSha) : null;
      return {
        headSha: view.headSha,
        verdict: view.verdict,
        findings: view.verdict === "rejected" && view.train?.reason ? [view.train.reason] : [],
        summary: view.train?.summary ?? null,
        note,
        previewUrl: view.train?.previewUrl ?? null,
      };
    },
  },
  {
    name: "close_entries",
    description: "End a race's entry window now, so it can be decided.",
    shape: { hive: HiveSlugSchema, raceId: z.string().min(1).max(64) },
    run: async (ctx, a: { hive: string; raceId: string }) => {
      const agent = agentOf(ctx);
      return ctx.ports.queen(a.hive).closeRaceEntries({ hive: a.hive, raceId: a.raceId, user: agent.owner });
    },
  },
  {
    name: "pick",
    description: "Pick a PICKING race's winner by its attempt (any candidate, not only yours).",
    shape: { hive: HiveSlugSchema, raceId: z.string().min(1).max(64), attemptId: AttemptIdSchema },
    run: async (ctx, a: { hive: string; raceId: string; attemptId: string }) => {
      const agent = agentOf(ctx);
      const queen = ctx.ports.queen(a.hive);
      const view = await queen.getAttempt(a.attemptId);
      if (!view) throw new ToolError("NOT_FOUND", `attempt ${a.attemptId} not found`);
      if (isTerminalAttemptState(view.state)) throw new ToolError("ATTEMPT_EXPIRED", `attempt ${a.attemptId} is ${view.state}`);
      return queen.pick({ hive: a.hive, raceId: a.raceId, user: agent.owner, pick: { trainId: view.trainId } });
    },
  },
];
