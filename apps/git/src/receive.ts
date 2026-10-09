/**
 * The write path (docs/human-push-design.md §4.2, §4.3, §9): a `git push` becomes a Submission.
 *
 *   read the command pkt-lines (the pack stays unread) → local pre-receive rules → Queen `gitIntent`
 *   → fork hive main into the Queen's train repo (readiness probe, `-rN` re-fork) → forward the body with the
 *   ref rewritten to the fork's `main` (streamed, 50 MB cap) → report-status rewritten back to the client's
 *   ref → `readCommit` → Queen `gitPushed` → `remote: QueenOS: …` lines + `ok <ref>`.
 *
 * Any failure after the intent calls `gitAborted` (the Queen ejects the train and deletes its fork) and
 * answers `ng <ref> …retry the push`. The client always gets a well-formed report-status (HTTP 200), so
 * git prints our reason instead of a transport error.
 */
import type { GitAborted, GitIntakeDecision, GitPushed, GitPushedResult, GitPushIntent, GateTarget, NotesProjection } from "@queenos/queen-types";
import { AGENT_HANDLE_RE, parseSubmissionTrailers } from "@queenos/queen-types";
import { band, concat, demuxSideband, drain, FLUSH, parsePkts, pkt, pktText, PktReader, remoteLine, ZERO_SHA } from "./pktline.js";
import { RepoNotFoundError } from "./tokens.js";
import { deleteRepoQuietly, forkTrain, httpEvidence, readHeadCommit, upstreamFetch, type ForkOptions, type UpstreamDeps } from "./upstream.js";

/** The QueenNode DO RPCs the proxy calls (apps/queen/src/queen-node.ts; contracts in queen-types git.ts). */
export interface QueenRpc {
  gitIntent(input: GitPushIntent): Promise<GitIntakeDecision>;
  gitPushed(input: GitPushed): Promise<GitPushedResult>;
  gitAborted(input: GitAborted): Promise<{ outcome: string }>;
  notesFor(hive: string, ref: string): Promise<NotesProjection>;
  getGateTarget(repo: string): Promise<GateTarget | null>;
}

export const DEFAULT_MAX_PACK_BYTES = 50 * 1024 * 1024;
/** The command section of a push is a few hundred bytes; bound it so a hostile client cannot make us buffer. */
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_COMMANDS = 64;
const SHA_RE = /^[0-9a-f]{40}$/;
const TARGET_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const REFUSALS = {
  oneBranch: "push one branch per submission",
  branchesOnly: "only branches can be pushed",
  main: "pushes to main are refused (the lander owns main)",
  deletion: "branch deletion is refused",
  badItem: "bad target: item/<id>[/<agent>] takes [A-Za-z0-9_-]{1,64}, then an optional /[A-Za-z0-9._-]{1,64} (no leading '.', no '..', not ending in '.lock')",
  badGoal: "bad target: goal/<slug>[/<agent>] takes [A-Za-z0-9_-]{1,64}, then an optional /[A-Za-z0-9._-]{1,64} (no leading '.', no '..', not ending in '.lock')",
  scope: "this token cannot push",
  tooLarge: "push too large (50 MB cap)",
  transient: "transient error, retry the push",
  expired: "push intent expired, retry the push",
} as const;

export interface PushContext {
  deps: UpstreamDeps;
  hive: string;
  /** The token owner's email, from the edge (`x-queen-user`). */
  user: string;
  /** The agent the token is bound to (edge `x-queen-agent*`); `model` is self-reported and unverified. */
  agent?: { name: string; model?: string };
  /** The token has the `push` scope (edge `x-queen-scopes`). */
  canPush: boolean;
  queen: QueenRpc;
  maxPackBytes: number;
  fork?: ForkOptions;
  log: string[];
}

export interface RefCommand {
  old: string;
  nu: string;
  ref: string;
}

interface RefResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

const RESULT_HEADERS = { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-cache" };

/** `QueenOS: <text>` on side-band 2 (git prints it as `remote: QueenOS: <text>`). */
export function queenLine(text: string): Uint8Array {
  return remoteLine(`QueenOS: ${text}`);
}

/**
 * A report-status (gitprotocol-pack(5)): `unpack <status>`, `ok <ref>` / `ng <ref> <reason>`, flush. With
 * side-band, `remote:` messages (band 2) come first and the report rides band 1, then a final flush.
 * Without side-band the messages cannot be shown; the `ng` reasons still are.
 */
export function reportStatus(sideband: boolean, unpack: string, results: RefResult[], msgs: Uint8Array[]): Uint8Array {
  const inner = concat(
    pkt(`unpack ${unpack}\n`),
    ...results.map((r) => pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${(r.reason ?? "refused").replace(/[\r\n]+/g, " ")}\n`)),
    FLUSH,
  );
  if (!sideband) return inner;
  return concat(...msgs, band(1, inner), FLUSH);
}

/** Parse an upstream report-status (side-banded or not). */
export function parseReport(body: Uint8Array, sideband: boolean): { unpack: string; results: RefResult[]; progress: Uint8Array[]; fatal: string[] } {
  let inner = body;
  let progress: Uint8Array[] = [];
  let fatal: string[] = [];
  if (sideband) {
    const d = demuxSideband(body);
    inner = d.data;
    progress = d.progress;
    fatal = d.fatal.map((f) => new TextDecoder().decode(f).trim());
  }
  let unpack = "ok";
  const results: RefResult[] = [];
  for (const p of parsePkts(inner)) {
    if (typeof p === "string") continue;
    const line = pktText(p);
    if (line.startsWith("unpack ")) unpack = line.slice(7);
    else if (line.startsWith("ok ")) results.push({ ref: line.slice(3), ok: true });
    else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      results.push(sp < 0 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, reason: rest.slice(sp + 1) });
    }
  }
  return { unpack, results, progress, fatal };
}

/**
 * §4.3 local rules (no state), on the command list only. Returns one refusal reason per command (null =
 * fine), or null when the push passes. The default branch counts as `main`. With an `agent` (the token is bound
 * to one), a branch handle suffix must be that agent's: a token can only push as its own agent.
 */
export function preReceive(cmds: RefCommand[], branch: string, agent?: string): (string | null)[] | null {
  const reasons = cmds.map((c): string | null => {
    if (!c.ref.startsWith("refs/heads/")) return REFUSALS.branchesOnly;
    if (c.ref === "refs/heads/main" || c.ref === `refs/heads/${branch}`) return REFUSALS.main;
    if (c.nu === ZERO_SHA) return REFUSALS.deletion;
    const target = /^refs\/heads\/(item|goal)\/(.*)$/.exec(c.ref);
    if (target) {
      // `<id>` or `<id>/<agent>`: the optional agent suffix gives each agent sharing a token its own ref.
      const [id, handle, ...deeper] = target[2]!.split("/");
      if (!TARGET_RE.test(id!) || (handle !== undefined && !AGENT_HANDLE_RE.test(handle)) || deeper.length) {
        return target[1] === "item" ? REFUSALS.badItem : REFUSALS.badGoal;
      }
      if (agent !== undefined && handle !== undefined && handle !== agent) {
        return `branch handle ${handle} does not match this token's agent ${agent}; push ${target[1]}/${id} or ${target[1]}/${id}/${agent}`;
      }
    }
    if (cmds.length > 1) return REFUSALS.oneBranch;
    return null;
  });
  return reasons.some(Boolean) ? reasons : null;
}

class BadRequest extends Error {}

async function readCommands(pr: PktReader): Promise<{ cmds: RefCommand[]; shallow: string[]; caps: string[] }> {
  const cmds: RefCommand[] = [];
  const shallow: string[] = [];
  let caps: string[] = [];
  for (;;) {
    const p = await pr.next();
    if (p === null || p === "flush") break;
    if (typeof p === "string") continue;
    if (pr.consumed > MAX_COMMAND_BYTES || cmds.length >= MAX_COMMANDS) throw new BadRequest("too many ref updates");
    let line = pktText(p);
    if (line.startsWith("shallow ")) {
      shallow.push(line);
      continue;
    }
    if (line.startsWith("push-cert")) throw new BadRequest("signed pushes are not supported");
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      caps = line.slice(nul + 1).trim().split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    const [old, nu, ref] = line.split(" ");
    if (!old || !nu || !ref || !SHA_RE.test(old) || !SHA_RE.test(nu)) throw new BadRequest("malformed ref update");
    cmds.push({ old, nu, ref });
  }
  return { cmds, shallow, caps };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A Queen RPC error's code (`QueenError` messages are `CODE: detail`). */
function queenCode(e: unknown): string | null {
  return /^([A-Z_]{3,}):/.exec(messageOf(e))?.[1] ?? null;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** POST git-receive-pack on the hive root. */
export async function handleReceivePack(ctx: PushContext, req: Request): Promise<Response> {
  const { deps, hive, log } = ctx;
  const t0 = deps.now();
  if (!req.body) return new Response("QueenOS: empty push request\n", { status: 400 });
  const gzip = (req.headers.get("content-encoding") ?? "").includes("gzip");
  const source = gzip ? req.body.pipeThrough(new DecompressionStream("gzip")) : req.body;
  const pr = new PktReader(source.getReader());

  let parsed: Awaited<ReturnType<typeof readCommands>>;
  try {
    parsed = await readCommands(pr);
  } catch (e) {
    return new Response(`QueenOS: ${e instanceof BadRequest ? e.message : "malformed push request"}\n`, { status: 400 });
  }
  const { cmds, shallow, caps } = parsed;
  const headBytes = pr.consumed;
  const sideband = caps.includes("side-band-64k") || caps.includes("side-band");
  log.push(`receive-pack cmds=${JSON.stringify(cmds.map((c) => `${c.old.slice(0, 7)}..${c.nu.slice(0, 7)} ${c.ref}`))} caps=${caps.join(",")}`);

  let restReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const rest = () => (restReader ??= pr.rest());
  const reply = (results: RefResult[], msgs: Uint8Array[], unpack = "ok") =>
    new Response(reportStatus(sideband, unpack, results, msgs), { headers: RESULT_HEADERS });
  /** Refuse every command (nothing forked); drain the pack first so the client is not cut off. */
  const refuseAll = async (reasons: (string | null)[], msgs: Uint8Array[]) => {
    await drain(rest());
    log.push(`refused in ${deps.now() - t0} ms: ${reasons.filter(Boolean).join("; ")}`);
    return reply(
      cmds.map((c, i) => ({ ref: c.ref, ok: false, reason: reasons[i] ?? REFUSALS.oneBranch })),
      msgs,
    );
  };

  if (cmds.length === 0) {
    await drain(rest());
    return reply([], []);
  }

  // ── local pre-receive rules (§4.3) ──
  if (!ctx.canPush) {
    return refuseAll(cmds.map(() => REFUSALS.scope), [queenLine("push refused"), queenLine("this git token has the read scope only; create a token with push on the dashboard")]);
  }
  let branch: string;
  try {
    branch = (await deps.tokens.auth(hive, "read", hive)).defaultBranch;
  } catch (e) {
    if (e instanceof RepoNotFoundError) return refuseAll(cmds.map(() => `no hive ${hive}`), [queenLine(`push refused: no hive ${hive}`)]);
    log.push(`hive lookup failed: ${messageOf(e)}`);
    return refuseAll(cmds.map(() => REFUSALS.transient), [queenLine("push not received: the hive is unavailable; retry the push")]);
  }
  const declared = gzip ? null : req.headers.get("content-length");
  const packBytesDeclared = declared ? Number(declared) - headBytes : null;
  const ruleReasons = preReceive(cmds, branch, ctx.agent?.name);
  if (ruleReasons) {
    const hint = ruleReasons.some((r) => r === REFUSALS.main || r === REFUSALS.branchesOnly || r === REFUSALS.oneBranch);
    return refuseAll(ruleReasons, [
      queenLine("push refused"),
      ...cmds.flatMap((c, i) => (ruleReasons[i] ? [queenLine(`  ${c.ref}: ${ruleReasons[i]}`)] : [])),
      ...(hint ? [queenLine("push a branch instead, e.g. git push origin HEAD:item/<id>")] : []),
    ]);
  }
  if (packBytesDeclared !== null && packBytesDeclared > ctx.maxPackBytes) {
    return refuseAll([REFUSALS.tooLarge], [queenLine(`push refused: ${REFUSALS.tooLarge}`)]);
  }

  // ── Queen: state rules, train id and fork name (§4.3 "Queen") ──
  const cmd = cmds[0]!;
  let decision: GitIntakeDecision;
  try {
    decision = await ctx.queen.gitIntent({
      hive,
      user: ctx.user,
      ref: cmd.ref,
      oldSha: cmd.old,
      newSha: cmd.nu,
      ...(ctx.agent ? { agent: ctx.agent } : {}),
    });
  } catch (e) {
    log.push(`gitIntent failed: ${messageOf(e)}`);
    return refuseAll([REFUSALS.transient], [queenLine("push not received: the Queen is unavailable; retry the push")]);
  }
  if (decision.verdict === "refuse") {
    const msgs = decision.messages.length ? decision.messages : [`push refused: ${decision.reason}`];
    return refuseAll([decision.reason], msgs.map(queenLine));
  }
  const { trainId } = decision;
  log.push(`intent accepted: train ${trainId} repo ${decision.repo}`);

  let forkedRepo: string | null = null;
  /** After the intent: tell the Queen, clean up what only we know about, answer `ng`. */
  const abort = async (reason: string, clientReason: string, msgs: Uint8Array[]) => {
    try {
      await ctx.queen.gitAborted({ hive, trainId, reason: clip(reason, 200) });
    } catch (e) {
      // The Queen's intent watchdog ejects the train after 10 min anyway (§9).
      log.push(`gitAborted failed: ${messageOf(e)}`);
    }
    // The Queen deletes the repo it named; a `-rN` re-fork is ours to delete.
    if (forkedRepo && forkedRepo !== decision.repo) await deleteRepoQuietly(deps, forkedRepo);
    await drain(rest());
    log.push(`aborted after ${deps.now() - t0} ms: ${reason}`);
    return reply([{ ref: cmd.ref, ok: false, reason: clientReason }], msgs);
  };

  // ── fork hive main into the train repo (§2.2) ──
  let baseSha: string;
  try {
    const tf = deps.now();
    const f = await forkTrain(deps, hive, branch, decision.repo, ctx.fork);
    forkedRepo = f.repo;
    baseSha = f.baseSha;
    log.push(`forked ${hive} -> ${f.repo} in ${deps.now() - tf} ms (tries ${f.attempted.length}) base ${baseSha.slice(0, 12)}`);
  } catch (e) {
    return abort(`fork failed: ${messageOf(e)}`, REFUSALS.transient, [queenLine("push not received: could not prepare the train fork; retry the push")]);
  }
  if (cmd.nu === baseSha) {
    return abort("nothing to submit: the head is main", "nothing to submit (this commit is main's head)", [queenLine("push refused: this commit is already main's head; commit a change first")]);
  }

  // ── forward: rewritten command + the client's pack, streamed with the size cap ──
  const upstreamRef = `refs/heads/${branch}`;
  const head = concat(...shallow.map((s) => pkt(`${s}\n`)), pkt(`${baseSha} ${cmd.nu} ${upstreamRef}\0${caps.join(" ")}\n`), FLUSH);
  const total = packBytesDeclared !== null ? packBytesDeclared + head.length : null;
  const pipe: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } =
    total !== null ? new FixedLengthStream(total) : new TransformStream<Uint8Array, Uint8Array>();
  const controller = new AbortController();
  let packBytes = 0;
  let tooLarge = false;
  let clientError: string | null = null;
  const reader = rest();
  const pump = (async () => {
    const w = pipe.writable.getWriter();
    try {
      await w.write(head);
      for (;;) {
        const { done, value } = await reader.read().catch((e: unknown) => {
          clientError = messageOf(e);
          throw e;
        });
        if (done) break;
        packBytes += value.length;
        if (packBytes > ctx.maxPackBytes) {
          tooLarge = true;
          const err = new Error("pack over the size cap");
          controller.abort(err);
          await w.abort(err).catch(() => undefined);
          await drain(reader);
          return;
        }
        await w.write(value);
      }
      await w.close();
    } catch (e) {
      await w.abort(e).catch(() => undefined);
      await drain(reader);
    }
  })();
  const upstream = upstreamFetch(deps, {
    hive,
    repo: forkedRepo,
    scope: "write",
    endpoint: "git-receive-pack",
    method: "POST",
    body: pipe.readable,
    clientHeaders: req.headers,
    headers: { "content-length": total !== null ? String(total) : null, "content-encoding": null },
    signal: controller.signal,
  });
  const [up] = await Promise.allSettled([upstream, pump]);

  if (tooLarge) return abort(`pack over ${ctx.maxPackBytes} bytes`, REFUSALS.tooLarge, [queenLine(`push refused: ${REFUSALS.tooLarge}`)]);
  if (clientError) return abort(`client upload failed: ${clientError}`, REFUSALS.transient, []);
  if (up.status === "rejected") {
    return abort(`upstream receive-pack failed: ${messageOf(up.reason)}`, REFUSALS.transient, [queenLine("push not received: the upload to the train fork failed; retry the push")]);
  }
  const res = up.value;
  if (res.status !== 200) {
    const evidence = await httpEvidence(res, "git-receive-pack");
    return abort(`upstream receive-pack ${evidence}`, REFUSALS.transient, [queenLine("push not received: the train fork is unavailable; retry the push")]);
  }
  let report: ReturnType<typeof parseReport>;
  try {
    report = parseReport(new Uint8Array(await res.arrayBuffer()), sideband);
  } catch (e) {
    return abort(`upstream report unreadable: ${messageOf(e)}`, REFUSALS.transient, [queenLine("push not received; retry the push")]);
  }
  const mine = report.results.find((r) => r.ref === upstreamRef);
  if (report.fatal.length || report.unpack !== "ok" || !mine?.ok) {
    const why = report.fatal[0] ?? (report.unpack !== "ok" ? `unpack ${report.unpack}` : (mine?.reason ?? "no status for the ref"));
    return abort(`upstream refused: ${why}`, clip(`rejected by storage: ${why}`, 200), [queenLine(`push not received: ${clip(why, 150)}`)]);
  }
  log.push(`forwarded ${packBytes} pack bytes to ${forkedRepo}`);

  // ── the Submission (§4.2) ──
  let commit: { title: string; message: string };
  try {
    commit = await readHeadCommit(deps, forkedRepo, cmd.nu);
  } catch (e) {
    return abort(`readCommit failed: ${messageOf(e)}`, REFUSALS.transient, [queenLine("push not received: could not read the pushed commit; retry the push")]);
  }
  const pushed: GitPushed = {
    hive,
    trainId,
    repo: forkedRepo,
    ref: cmd.ref,
    headSha: cmd.nu,
    baseSha,
    title: clip(commit.title || `(no subject) ${cmd.nu.slice(0, 12)}`, 120),
    message: clip(commit.message, 4000),
    trailers: parseSubmissionTrailers(commit.message).raw,
  };
  let result: GitPushedResult | null = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      result = await ctx.queen.gitPushed(pushed);
    } catch (e) {
      const code = queenCode(e);
      log.push(`gitPushed failed: ${messageOf(e)}`);
      if (code === "CONFLICT") return abort(`gitPushed: ${messageOf(e)}`, REFUSALS.expired, [queenLine("push not received: the push intent expired; retry the push")]);
      // A coded Queen error will not change on retry; an RPC/transport error might (gitPushed is idempotent).
      if (code || attempt === 1) return abort(`gitPushed: ${messageOf(e)}`, REFUSALS.transient, [queenLine("push not received: the Queen could not record it; retry the push")]);
    }
  }
  log.push(`submission ${result!.disposition} item ${result!.itemId} in ${deps.now() - t0} ms`);
  const msgs = [
    ...report.progress.map((p) => band(2, p)),
    ...decision.messages.map(queenLine),
    ...result!.messages.map(queenLine),
  ];
  return reply([{ ref: cmd.ref, ok: true }], msgs);
}
