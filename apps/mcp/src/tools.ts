/**
 * The MCP tools (spec §6). Each takes and returns JSON; errors are `{code, message, retryable, retryAfterMs?}` (spec §11). Every tool except
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
  SYNC_TOKEN_TTL_S,
  WAIT_MAX_MS,
  WorkStatusSchema,
  isTerminalAttemptState,
  type AttemptResult,
  type AttemptState,
  type AttemptVerdict,
  type AttemptView,
  type McpAgentIdentity,
  type McpToolError,
  type SyncBaseResult,
  type Race,
} from "@queenos/queen-types";
import { attemptDir, cleanupOf, configCommand, syncCommand, syncNext } from "./commands";
import { ToolError, artifactsUnavailable, fromQueen, messageOf, refusal } from "./errors";
import type { McpPorts, McpRepoHandle } from "./ports";
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

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: McpToolError };

export const WAIT_POLL_MS = 2_000;
const ItemIdSchema = z.string().min(1).max(64);

/** Validate (field names only in the message), run, and turn any failure into `{code, message}`. */
export async function callTool(spec: ToolSpec, ctx: ToolCtx, raw: unknown): Promise<ToolOutcome> {
  const parsed = z.object(spec.shape).safeParse(raw ?? {});
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(input)"))].join(", ");
    return { ok: false, error: { code: "INVALID_INPUT", message: `invalid ${fields}`.slice(0, 200), retryable: false } };
  }
  try {
    return { ok: true, value: await spec.run(ctx, parsed.data as never) };
  } catch (e) {
    const t = e instanceof ToolError ? e : fromQueen(e);
    return { ok: false, error: { code: t.code, message: t.message, retryable: t.retryable, ...(t.retryAfterMs !== undefined ? { retryAfterMs: t.retryAfterMs } : {}), ...(t.items ? { items: t.items } : {}) } };
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

/** The attempt view as the agent sees it: the v18 fields read `?? null` (an older Queen omits them), terminal ones carry the cleanup. */
const withCleanup = (v: AttemptView) => {
  const view = { ...v, verdictKind: v.verdictKind ?? null, regating: v.regating ?? null, rework: v.rework ?? null };
  return isTerminalAttemptState(v.state) ? { ...view, cleanup: cleanupOf(v.attemptId) } : view;
};

const FINDING = /^Queen-Finding: (.+)$/gm;

/** The findings of a rejection: the note's `Queen-Finding` lines, else the train's reason. Infra has none. */
function findingsOf(view: AttemptView, note: string | null): string[] {
  if (view.verdict !== "rejected" || view.verdictKind === "infra") return [];
  if (view.verdictKind === "conflict") {
    const c = view.train?.conflict;
    if (c?.paths.length) return c.paths.slice(0, 50);
    return [c?.summary ?? view.train?.reason ?? "merge conflict"];
  }
  const lines = note ? [...note.matchAll(FINDING)].map((m) => m[1]!.trim().slice(0, 300)) : [];
  if (lines.length) return lines;
  return view.train?.reason ? [view.train.reason] : [];
}

/** retry_gates against a Queen that predates the attemptRegate RPC: workerd's "The RPC receiver does not implement the method". */
const lacksRpc = (e: unknown): boolean => /does not implement the method/i.test(messageOf(e));

/**
 * `wait` on an attempt: verdict = its head PASSED / REJECTED (or WON); decided = WON / LOST; landed = LANDED. Any terminal state ends every wait.
 * REJECTED ends every wait too (rework spec 6.2): a WON / PASSED attempt that goes back to REJECTED (conflict, human reject) must wake the waiter.
 */
export function attemptReached(state: AttemptState, until: "verdict" | "decided" | "landed"): boolean {
  if (isTerminalAttemptState(state)) return true;
  if (state === "REJECTED") return true;
  if (until === "verdict") return state === "PASSED" || state === "WON";
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
    description: "Orchestrators only: file a goal in an external hive. Write it as a work spec, like a ticket, for whoever picks it up: the outcome, acceptance criteria and constraints. It becomes one item agents race on. judge: auto (the Queen ranks) or pick (a human or an orchestrator picks, and may reject with a reason). entryWindowMs: how long the race takes entries after its first push (max 1 h).",
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
    description: "One item and its race: state, shared base commit, entry window and candidates (attempt, agent, claimed model, verdict, kind: findings, infra, conflict or human; rework, preview).",
    shape: { hive: HiveSlugSchema, itemId: ItemIdSchema },
    run: async (ctx, a: { hive: string; itemId: string }) => {
      agentOf(ctx);
      await requireHive(ctx, a.hive);
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
                .map((x) => ({ attemptId: x.attemptId, agent: x.agentName, claimedModel: x.model, verdict: x.verdict, kind: x.verdictKind ?? null, previewUrl: x.train?.previewUrl ?? null, rework: x.rework ?? null })),
            }
          : null,
      };
    },
  },
  {
    name: "start_attempt",
    description:
      "Start an attempt on an item (or a goal with one open item): you get your own fork of the item's frozen base and a 2 h token for it. Run setupCommand (it creates the clone), commit, `git push origin main`. Can take up to a minute. A rejection may come with a rework slot (rework.dueAt): fix it (for a conflict: sync_base, then rebase) and push again before dueAt, as the same candidate.",
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
    description: "Your attempt: a fresh 2 h token (older tokens of the fork are revoked). Run the returned configCommand (it replaces the clone's header).",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }) => {
      const agent = agentOf(ctx);
      const { hive } = await ownAttempt(ctx, agent, a.attemptId);
      const r = await ctx.ports.queen(hive).attemptRefresh({ hive, attemptId: a.attemptId, owner: agent.owner, agentId: agent.agentId });
      if (!r.ok) throw refusal(r);
      try {
        using h = await ctx.ports.artifacts.get(r.attempt.repo);
        const [info, tok] = await Promise.all([h.info(), h.createToken("write", ATTEMPT_TOKEN_TTL_S)]);
        const remote = info.remote.replace(/\/+$/, "");
        let cmd: string;
        try {
          cmd = configCommand(remote, tok.plaintext, attemptDir(a.attemptId));
        } catch (e) {
          // A malformed token must not cost the agent its working one: drop the new token, keep the old.
          await h.revokeToken(tok.id).catch(() => undefined);
          throw e;
        }
        for (const t of (await h.listTokens()).tokens) if (t.id !== tok.id && t.state === "active") await h.revokeToken(t.id);
        return { expiresAt: Date.parse(tok.expiresAt) || r.attempt.expiresAt, configCommand: cmd };
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
      if (!r.ok) throw refusal(r);
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
    description: `Long-poll (at most ${WAIT_MAX_MS} ms) until your attempt (attemptId) or an item (hive + itemId) reaches: verdict, decided or landed. On timeout returns changed:false; call again. A rejection may open a rework slot (attempt.rework): fix and push again before rework.dueAt.`,
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
      if (!own) await requireHive(ctx, a.hive!);
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
    description: "Your attempt's verdict on its current head: the v1 verdict note, kind (findings = fix and push; infra = the gate could not run, call retry_gates; conflict = sync_base, rebase onto queen/main, push; human = a judge's reason, address it and push), findings, rework ({reason, dueAt, round}: you may push again as the same candidate before dueAt), next, regating and the preview URL.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }) => {
      const { hive, view } = await ownAttempt(ctx, agentOf(ctx), a.attemptId);
      const note = view.headSha ? await ctx.ports.queen(hive).verdictNote(view.headSha) : null;
      const kind = view.verdictKind ?? null;
      // An older Queen has no `rework` key (keep today's next); a newer one says null when no slot is open.
      const rework = view.rework;
      const due = rework ? new Date(rework.dueAt).toISOString() : null;
      const next =
        kind === "infra"
          ? "retry_gates"
          : kind === "conflict"
            ? due && `call sync_base, rebase onto queen/main, push again before ${due}`
            : kind === "human"
              ? due && `address the reviewer's reason, push again before ${due}`
              : kind === "findings"
                ? rework === undefined
                  ? "fix and push"
                  : due && `fix and push before ${due}`
                : null;
      return {
        headSha: view.headSha,
        verdict: view.verdict,
        kind,
        findings: findingsOf(view, note),
        summary: view.train?.summary ?? null,
        note,
        previewUrl: view.train?.previewUrl ?? null,
        regating: view.regating ?? null,
        rework: rework ?? null,
        next: next || null,
      };
    },
  },
  {
    name: "retry_gates",
    description: "Your attempt: re-run the gates on its current head when the last verdict was kind infra (the gate could not run, nothing is wrong with your change). Idempotent; at most 3 per attempt, one a minute.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }) => {
      const agent = agentOf(ctx);
      const { hive } = await ownAttempt(ctx, agent, a.attemptId);
      let r;
      try {
        r = await ctx.ports.queen(hive).attemptRegate({ hive, attemptId: a.attemptId, owner: agent.owner, agentId: agent.agentId });
      } catch (e) {
        if (lacksRpc(e)) throw new ToolError("UNAVAILABLE", "retry_gates needs a newer Queen", { retryable: false });
        throw e;
      }
      if (!r.ok) throw refusal(r);
      return { changed: r.changed, state: r.attempt.state, trainId: r.attempt.trainId, race: r.attempt.race };
    },
  },
  {
    name: "sync_base",
    description:
      "Your attempt: bring the hive's current main into your clone as queen/main, to rebase on (READY, or REJECTED with an open rework slot, e.g. after a conflict). Run the returned syncCommand (fetch only; it fails if main moved, then call again), rebase, run the tests, push --force-with-lease origin HEAD:main. Your next push is gated against baseSha.",
    shape: { attemptId: AttemptIdSchema },
    run: async (ctx, a: { attemptId: string }): Promise<SyncBaseResult> => {
      const agent = agentOf(ctx);
      const { hive, view } = await ownAttempt(ctx, agent, a.attemptId);
      if (isTerminalAttemptState(view.state)) throw new ToolError("ATTEMPT_EXPIRED", `attempt ${a.attemptId} is ${view.state}`);
      const slotOpen = !!view.rework && view.rework.dueAt > ctx.ports.now();
      if (view.state !== "READY" && !(view.state === "REJECTED" && slotOpen)) {
        throw new ToolError("CONFLICT", `attempt ${a.attemptId} is ${view.state === "REJECTED" ? "REJECTED with no open rework slot" : view.state}; sync_base needs READY or an open rework slot`);
      }
      const unavailable = () => new ToolError("ARTIFACTS_UNAVAILABLE", "reading the hive's main failed; retry sync_base", { retryAfterMs: 5000 });
      let handle: McpRepoHandle;
      try {
        handle = await ctx.ports.artifacts.get(hive);
      } catch {
        throw unavailable();
      }
      using repo = handle;
      let tok: { id: string; plaintext: string } | null = null;
      // Only the token this call minted is ever revoked: the hive repo has other tokens.
      const revoke = async () => {
        if (tok) await repo.revokeToken(tok.id).catch(() => false);
      };
      let baseSha: string;
      let cmd: string;
      try {
        const remote = (await repo.info()).remote.replace(/\/+$/, "");
        baseSha = (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? "";
        if (!/^[0-9a-f]{40}$/.test(baseSha)) throw unavailable();
        tok = await repo.createToken("read", SYNC_TOKEN_TTL_S);
        cmd = syncCommand(remote, tok.plaintext, baseSha, attemptDir(a.attemptId));
      } catch (e) {
        await revoke();
        throw e instanceof ToolError ? e : unavailable();
      }
      let r: AttemptResult;
      try {
        r = await ctx.ports.queen(hive).attemptSyncBase({ hive, attemptId: a.attemptId, owner: agent.owner, agentId: agent.agentId, baseSha });
      } catch (e) {
        await revoke();
        if (lacksRpc(e)) throw new ToolError("UNAVAILABLE", "sync_base needs a newer Queen", { retryable: false });
        throw e;
      }
      if (!r.ok) {
        await revoke();
        throw refusal(r);
      }
      return { baseSha, syncCommand: cmd, next: syncNext(attemptDir(a.attemptId)) };
    },
  },
  {
    name: "close_entries",
    description: "End a race's entry window now, so it can be decided.",
    shape: { hive: HiveSlugSchema, raceId: z.string().min(1).max(64) },
    run: async (ctx, a: { hive: string; raceId: string }) => {
      const agent = agentOf(ctx);
      await requireHive(ctx, a.hive);
      return ctx.ports.queen(a.hive).closeRaceEntries({ hive: a.hive, raceId: a.raceId, user: agent.owner });
    },
  },
  {
    name: "pick",
    description: "Pick a PICKING race's winner by its attempt (any candidate, not only yours).",
    shape: { hive: HiveSlugSchema, raceId: z.string().min(1).max(64), attemptId: AttemptIdSchema },
    run: async (ctx, a: { hive: string; raceId: string; attemptId: string }) => {
      const agent = agentOf(ctx);
      await requireHive(ctx, a.hive);
      const queen = ctx.ports.queen(a.hive);
      const view = await queen.getAttempt(a.attemptId);
      if (!view) throw new ToolError("NOT_FOUND", `attempt ${a.attemptId} not found`);
      if (isTerminalAttemptState(view.state)) throw new ToolError("ATTEMPT_EXPIRED", `attempt ${a.attemptId} is ${view.state}`);
      return queen.pick({ hive: a.hive, raceId: a.raceId, user: agent.owner, pick: { trainId: view.trainId } });
    },
  },
  {
    name: "reject",
    description:
      "Send candidates of a race you are judging back for rework, with a reason the agent can act on (what is wrong and what you expect instead). target: an attemptId, or \"all\". Only while the item's race waits for a pick (PICKING).",
    shape: { hive: HiveSlugSchema, itemId: ItemIdSchema, target: z.union([AttemptIdSchema, z.literal("all")]), reason: z.string().min(1).max(300) },
    run: async (ctx, a: { hive: string; itemId: string; target: string; reason: string }) => {
      const agent = agentOf(ctx);
      await requireHive(ctx, a.hive);
      const queen = ctx.ports.queen(a.hive);
      const detail = await queen.getItemDetail(a.itemId);
      const race = detail.races.filter((r) => r.state === "PICKING").at(-1);
      if (!race) throw new ToolError("CONFLICT", `item ${a.itemId} has no race waiting for a pick`);
      let trainId = "all";
      if (a.target !== "all") {
        const view = await queen.getAttempt(a.target);
        if (!view) throw new ToolError("NOT_FOUND", `attempt ${a.target} not found`);
        if (!race.trainIds.includes(view.trainId)) throw new ToolError("CONFLICT", `attempt ${a.target} is not a candidate of race ${race.raceId}`);
        trainId = view.trainId;
      }
      let r;
      try {
        r = await queen.rejectRace({ hive: a.hive, raceId: race.raceId, user: agent.owner, reject: { trainId, reason: a.reason } });
      } catch (e) {
        if (lacksRpc(e)) throw new ToolError("UNAVAILABLE", "reject needs a newer Queen", { retryable: false });
        throw e;
      }
      return { outcome: r.outcome, race: { raceId: r.race.raceId, state: r.race.state, reopens: r.race.reopens ?? 0 }, fallback: r.fallback };
    },
  },
];
