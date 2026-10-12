/**
 * start_attempt (spec §6, §7, §11): Queen attemptIntent (polling BASE_PENDING) → on the item's first attempt, fork hive
 * main read-only into the race base and pin it (attemptBaseReady) → fork the BASE into the attempt fork → mint a 2 h
 * write token for that fork only → attemptReady. Every failure after the intent aborts the attempt and deletes its fork.
 */
import {
  ATTEMPT_TOKEN_TTL_S,
  BASE_PENDING_MAX_WAIT_MS,
  BASE_PENDING_POLL_MS,
  MAX_OPEN_ATTEMPTS_PER_AGENT,
  isTerminalAttemptState,
  type AttemptIntentDecision,
  type McpAgentIdentity,
} from "@queenos/queen-types";
import { RepoNotFoundError, deleteRepoQuietly, forkRepo, type ForkResult } from "@queenos/hive-kit/artifacts";
import { GIT_NOTE, attemptDir, cloneCommand, configCommand } from "./commands";
import { ToolError, artifactsUnavailable, fromQueen, messageOf } from "./errors";
import type { McpPorts } from "./ports";

export interface StartAttemptResult {
  attemptId: string;
  itemId: string;
  remote: string;
  token: string;
  expiresAt: number;
  /** The item's shared base commit (every candidate of the race starts here). */
  baseSha: string;
  dir: string;
  cloneCommand: string;
  configCommand: string;
  note: string;
}

const clip = (s: string, n = 200) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The agent's open attempts, after dropping the ones the Queen says are terminal (or gone). */
export async function openAttempts(ports: McpPorts, agent: McpAgentIdentity): Promise<{ hive: string; attemptId: string }[]> {
  const identity = ports.identity(agent.agentId);
  const open: { hive: string; attemptId: string }[] = [];
  for (const r of (await identity.attempts()).filter((x) => x.open)) {
    const view = await ports.queen(r.hive).getAttempt(r.attemptId);
    if (!view || isTerminalAttemptState(view.state)) await identity.closeAttempt(r.attemptId);
    else open.push({ hive: r.hive, attemptId: r.attemptId });
  }
  return open;
}

export async function startAttempt(ports: McpPorts, agent: McpAgentIdentity, input: { hive: string; itemId?: string; goalId?: string }): Promise<StartAttemptResult> {
  const { hive } = input;
  if ((await openAttempts(ports, agent)).length >= MAX_OPEN_ATTEMPTS_PER_AGENT) {
    throw new ToolError("CAP_EXCEEDED", `open attempts per agent: ${MAX_OPEN_ATTEMPTS_PER_AGENT} reached; end_attempt one or wait for one to resolve`);
  }
  const queen = ports.queen(hive);
  const target = input.itemId !== undefined ? { itemId: input.itemId } : { goalId: input.goalId! };
  const started = ports.now();
  let d: AttemptIntentDecision;
  for (;;) {
    d = await queen.attemptIntent({ hive, owner: agent.owner, agent, target });
    // Another first attempt is creating the item's base: wait for it here, so two agents starting together both succeed.
    if (d.verdict === "accept" || d.code !== "BASE_PENDING" || ports.now() - started + BASE_PENDING_POLL_MS > BASE_PENDING_MAX_WAIT_MS) break;
    await ports.sleep(BASE_PENDING_POLL_MS);
  }
  if (d.verdict === "refuse") throw new ToolError(d.code, d.message, d.items);
  const identity = ports.identity(agent.agentId);
  await identity.addAttempt({ hive, attemptId: d.attemptId });

  let baseRepo: string;
  let baseSha: string;
  if (d.base.kind === "create") {
    let b: ForkResult | null = null;
    try {
      b = await forkRepo(ports.fork, hive, "main", d.base.baseRepo, { readOnly: true, probe: false, description: `QueenOS race base of item ${d.itemId}`, logPrefix: "mcp" });
      await queen.attemptBaseReady({ hive, itemId: d.itemId, baseRepo: b.repo, baseSha: b.baseSha });
      baseRepo = b.repo;
      baseSha = b.baseSha;
    } catch (e) {
      // A base that was forked but not pinned is unknown to the Queen: delete it here or it leaks.
      if (b) await deleteRepoQuietly(ports.fork, b.repo);
      await queen.attemptBaseFailed({ hive, itemId: d.itemId, baseRepo: b?.repo ?? d.base.baseRepo, attemptId: d.attemptId, reason: clip(messageOf(e)) }).catch(() => undefined);
      await identity.closeAttempt(d.attemptId);
      if (e instanceof RepoNotFoundError) throw new ToolError("NOT_FOUND", `hive repo ${hive} not found`);
      if (b) throw fromQueen(e);
      throw artifactsUnavailable("base fork", e);
    }
  } else {
    baseRepo = d.base.baseRepo;
    baseSha = d.base.baseSha;
  }

  let forked: ForkResult | null = null;
  let queenCall = false; // once true, a non-ToolError throw came from the Queen, not Artifacts
  try {
    forked = await forkRepo(ports.fork, baseRepo, "main", d.repo, { description: `QueenOS attempt ${d.attemptId} (agent ${agent.name})`, logPrefix: "mcp" });
    if (forked.baseSha !== baseSha) throw new ToolError("BASE_MOVED", `the fork's head ${forked.baseSha.slice(0, 12)} is not the race base ${baseSha.slice(0, 12)}`);
    using h = await ports.artifacts.get(forked.repo);
    const [info, tok] = await Promise.all([h.info(), h.createToken("write", ATTEMPT_TOKEN_TTL_S)]);
    const expiresAt = Date.parse(tok.expiresAt) || ports.now() + ATTEMPT_TOKEN_TTL_S * 1000;
    queenCall = true;
    const ready = await queen.attemptReady({ hive, attemptId: d.attemptId, repo: forked.repo, baseSha, expiresAt });
    if (!ready.ok) throw new ToolError(ready.code, ready.message);
    const remote = info.remote.replace(/\/+$/, "");
    const dir = attemptDir(d.attemptId);
    return {
      attemptId: d.attemptId,
      itemId: d.itemId,
      remote,
      token: tok.plaintext,
      expiresAt,
      baseSha,
      dir,
      cloneCommand: cloneCommand(remote, tok.plaintext, dir),
      configCommand: configCommand(remote, tok.plaintext, dir),
      note: GIT_NOTE,
    };
  } catch (e) {
    await deleteRepoQuietly(ports.fork, forked?.repo ?? d.repo);
    await queen.attemptAborted({ hive, attemptId: d.attemptId, reason: clip(messageOf(e)) }).catch(() => undefined);
    await identity.closeAttempt(d.attemptId);
    if (e instanceof ToolError) throw e;
    if (e instanceof RepoNotFoundError) throw new ToolError("NOT_FOUND", `base repo of item ${d.itemId} not found`);
    if (queenCall) throw fromQueen(e);
    throw artifactsUnavailable("attempt fork", e);
  }
}
