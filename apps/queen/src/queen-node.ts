/**
 * QueenNode: one Durable Object per hive (namespace). Central scheduler and
 * state machine for the speculative merge train; SQLite state plus WebSocket
 * broadcast to the War Room.
 *
 * Context compaction: the Queen never stores raw code, diffs or stack traces,
 * only Scribe summaries (<= 500 chars, enforced by the queen-types schemas).
 *
 * Orchestrator only: the Queen decides, records and dispatches. It performs no
 * external I/O itself; forks/deletes run in the Provisioner Workflow, preview
 * deploys/teardowns in the Herald Workflow, builds/landings in drones. Each
 * reports back over RPC (reportProvisionResult, reportDeployResult, ...).
 *
 * Release train (P3, src/release/planner.ts): every MERGED train cuts (or
 * supersedes, or queues behind a canary) a release. The Herald deploys it to
 * staging and canary, the Sentinel Workflow judges each step
 * (reportSentinelVerdict), and a human taps to ship (tapRelease).
 */
import { DurableObject } from "cloudflare:workers";
import {
  AppendAuditSchema,
  BuildResultSchema,
  DeployResultSchema,
  LandResultSchema,
  ProvisionResultSchema,
  QueenClientMessageSchema,
  ScribeSummarySchema,
  SentinelVerdictSchema,
  SubmitPromptSchema,
  TrainResultSchema,
  type AppendAuditInput,
  type AuditEvent,
  type BuildResult,
  type DeployResult,
  type Deployment,
  type LandResultInput,
  type MergeTrain,
  type PromptRun,
  type ProvisionResult,
  type QueenServerMessage,
  type Release,
  type ScribeSummary,
  type SentinelVerdict,
  type SubmitPrompt,
  type TrainResult,
} from "@queenos/queen-types";
import {
  listVerdicts,
  migrate,
  rowToAudit,
  rowToDeployment,
  rowToPrompt,
  rowToRelease,
  rowToTrain,
  upsertDeployment,
  upsertPrompt,
  upsertRelease,
  upsertTrain,
  upsertVerdict,
} from "./db";
import { WorkflowDroneDispatcher, type DroneDispatcher } from "./drones";
import { WorkflowCommandDispatcher, type DeployDispatcher, type ProvisionerDispatcher, type SentinelDispatcher } from "./executors";
import { QueenError, asQueenError, parseOrThrow } from "./errors";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  TrainPlanner,
  toMergeTrain,
  watchdogDeadline,
  toPromptRun,
  type Effect,
  type HiveState,
  type Outcome,
  type PlanResult,
  type PromptRecord,
  type TrainRecord,
} from "./train/planner";
import {
  DEFAULT_SENTINEL,
  ReleasePlanner,
  releaseWatchdogDeadline,
  toRelease,
  type ReleaseEffect,
  type ReleaseOutcome,
  type ReleasePlanResult,
  type ReleaseRecord,
  type ReleaseState,
  type SentinelSettings,
} from "./release/planner";

/** Header the Worker uses to tell the DO which hive a WebSocket belongs to. */
export const HIVE_HEADER = "x-queen-hive";
export const DEFAULT_HIVE = "queen";
/** Hive names become Artifacts repo names (`<hive>` and `<hive>-train-<id>`). */
export const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** Well below the 32,768 hibernatable-socket limit. */
export const MAX_SOCKETS = 1000;
/** Client frames are small JSON commands; refuse anything bigger. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Prompts are instructions, not code dumps. */
export const MAX_PROMPT_CHARS = 16_000;
/** Ledger entries are compact reasoning, not logs. */
export const MAX_GIT_NOTES_BYTES = 16 * 1024;
export const RECONCILE_DELAY_MS = 15_000;
/** Fire the watchdog alarm a little after the deadline so the command has surely expired. */
export const WATCHDOG_SLACK_MS = 1_000;

/** COMMAND_TIMEOUT_MS (wrangler var, milliseconds); default 10 min. */
export function commandTimeoutMs(env: { COMMAND_TIMEOUT_MS?: string | number }): number {
  const v = Number(env.COMMAND_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_COMMAND_TIMEOUT_MS;
}
/** SENTINEL_WINDOW_SECONDS / SENTINEL_MIN_REQUESTS (wrangler vars); defaults 60 s / 100 requests. */
export function sentinelSettings(env: { SENTINEL_WINDOW_SECONDS?: string | number; SENTINEL_MIN_REQUESTS?: string | number }): SentinelSettings {
  const int = (v: unknown, min: number, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min ? n : fallback;
  };
  return {
    windowSeconds: int(env.SENTINEL_WINDOW_SECONDS, 5, DEFAULT_SENTINEL.windowSeconds),
    minRequests: int(env.SENTINEL_MIN_REQUESTS, 1, DEFAULT_SENTINEL.minRequests),
  };
}
/** Header the edge sets to the Cloudflare Access-verified user email (user routes only). */
export const USER_HEADER = "x-queen-user";
const SNAPSHOT_LIMIT = 200;
const RELEASE_SNAPSHOT_LIMIT = 20;
const IN_FLIGHT_SQL = "('STAGING', 'VALIDATING', 'AWAITING_TAP', 'CANARY')";
const AUDIT_SNAPSHOT_LIMIT = 50;

export interface QueenPorts {
  /** Provisioner Workflow (FORK / DELETE). */
  provisioner: ProvisionerDispatcher;
  /** Herald Workflow (DEPLOY / TEARDOWN / ROLLBACK). */
  herald: DeployDispatcher;
  /** Sentinel Workflow (release health verdicts). */
  sentinel: SentinelDispatcher;
  /** Drone Workflow (BUILD / REWORK / LAND). */
  dispatcher: DroneDispatcher;
}

/** Per-socket state; survives hibernation (<= 16 KiB). */
export interface SocketAttachment {
  id: string;
  role: "dashboard" | "drone";
  hive: string;
  subscribed: boolean;
  connectedAt: number;
}

export interface TrainUpdate {
  outcome: Outcome;
  train: MergeTrain | null;
}

export interface ReleaseUpdate {
  outcome: ReleaseOutcome;
  release: Release | null;
}

/** Everything one decision changed, persisted in one transaction (train and release planners). */
interface Persist {
  prompts: PromptRecord[];
  trains: TrainRecord[];
  deployments: Deployment[];
  releases: ReleaseRecord[];
  effects: (Effect | ReleaseEffect)[];
}

function merged(...plans: (PlanResult | ReleasePlanResult | null)[]): Persist {
  const out: Persist = { prompts: [], trains: [], deployments: [], releases: [], effects: [] };
  for (const p of plans) {
    if (!p) continue;
    if ("prompts" in p) out.prompts.push(...p.prompts);
    if ("trains" in p) out.trains.push(...p.trains);
    if ("releases" in p) out.releases.push(...p.releases);
    out.deployments.push(...p.deployments);
    out.effects.push(...p.effects);
  }
  return out;
}

type Snapshot = Extract<QueenServerMessage, { type: "snapshot" }>;

export function assertNamespace(namespace: string): void {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new QueenError("INVALID_INPUT", `invalid hive namespace "${namespace}" (letters, digits, . _ -; max 63)`);
  }
}

export class QueenNode extends DurableObject<Env> {
  readonly sql: SqlStorage;
  readonly ports: QueenPorts;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Runs on every wake: synchronous, idempotent and cheap.
    migrate(ctx.storage);
    // Heartbeats are answered by the runtime without waking the DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ports = this.createPorts(env);
  }

  /** Seam for tests: the clock used for planning and the watchdog. */
  protected now(): number {
    return Date.now();
  }

  /** Seam for tests and sim: override to inject fake executor / drone ports. */
  protected createPorts(env: Env): QueenPorts {
    return {
      provisioner: new WorkflowCommandDispatcher(env.PROVISIONER, "PROVISIONER"),
      herald: new WorkflowCommandDispatcher(env.HERALD, "HERALD"),
      sentinel: new WorkflowCommandDispatcher(env.SENTINEL, "SENTINEL"),
      dispatcher: new WorkflowDroneDispatcher(env.DRONES),
    };
  }

  // ── RPC surface ───────────────────────────────────────────────────────

  async submitPrompt(input: SubmitPrompt): Promise<PromptRun> {
    const prompt = parseOrThrow(SubmitPromptSchema, input, "prompt");
    assertNamespace(prompt.namespace);
    if (prompt.promptText.length > MAX_PROMPT_CHARS) {
      throw new QueenError("INVALID_INPUT", `promptText exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    const hive = this.hiveNamespace();
    if (hive !== null && hive !== prompt.namespace) {
      throw new QueenError("CONFLICT", `this hive is "${hive}", not "${prompt.namespace}"`);
    }
    const promptId = crypto.randomUUID();
    await this.apply(merged(this.plan(prompt.namespace, [], (p) => p.submit({ promptId, promptText: prompt.promptText }))));
    return toPromptRun(this.loadPrompt(promptId)!);
  }

  /** Gatekeeper verdict for a train (POST /internal/webhook/train-result). */
  async reportTrainResult(input: TrainResult): Promise<TrainUpdate> {
    const r = parseOrThrow(TrainResultSchema, input, "train result");
    return this.trainTransition(r.trainId, (p) => p.trainResult(r));
  }

  /** Builder pushed the train head (POST /internal/webhook/build-result). */
  async reportBuildResult(input: BuildResult): Promise<TrainUpdate> {
    const r = parseOrThrow(BuildResultSchema, input, "build result");
    return this.trainTransition(r.trainId, (p) => p.buildResult(r));
  }

  /**
   * Lander pushed (or failed to push) the head to main (POST /internal/webhook/land-result).
   * A MERGED train hands the new main head to the release planner, in the same transaction.
   */
  async reportLandResult(input: LandResultInput): Promise<TrainUpdate> {
    const r = parseOrThrow(LandResultSchema, input, "land result");
    return this.trainTransition(
      r.trainId,
      (p) => p.landResult(r),
      (plan, hive) => {
        const t = plan.outcome === "applied" ? plan.trains.find((x) => x.trainId === r.trainId && x.phase === "MERGED") : undefined;
        const headSha = t?.landedSha ?? t?.headSha;
        return t && headSha ? this.planRelease(hive, [], (rp) => rp.landed({ trainId: t.trainId, headSha })) : null;
      },
    );
  }

  /**
   * Provisioner outcome for a FORK or DELETE command
   * (POST /internal/webhook/provision-result). Idempotent by commandId: a
   * duplicate or superseded result returns an `ignored:*` outcome.
   */
  async reportProvisionResult(input: ProvisionResult): Promise<TrainUpdate> {
    const r = parseOrThrow(ProvisionResultSchema, input, "provision result");
    return this.trainTransition(r.trainId, (p) => p.provisionResult(r));
  }

  /**
   * Herald outcome (POST /internal/webhook/deploy-result). Idempotent by commandId.
   * - preview DEPLOY / TEARDOWN: the train is resolved from `trainId`, or else from the command id.
   * - staging / canary DEPLOY and ROLLBACK: routed to the release planner; the
   *   release is resolved from `releaseId`, or else from the command id.
   */
  async reportDeployResult(input: DeployResult): Promise<TrainUpdate | ReleaseUpdate> {
    const r = parseOrThrow(DeployResultSchema, input, "deploy result");
    if (r.environment !== "preview") {
      const releaseId = r.releaseId ?? this.releaseIdForCommand(r.commandId);
      if (!releaseId) throw new QueenError("NOT_FOUND", `no release for command ${r.commandId}`);
      return this.releaseTransition(releaseId, (p) => p.deployResult({ ...r, releaseId }));
    }
    const trainId = r.trainId ?? this.trainIdForCommand(r.commandId);
    if (!trainId) throw new QueenError("NOT_FOUND", `no train for command ${r.commandId}`);
    return this.trainTransition(trainId, (p) => p.deployResult({ ...r, trainId }));
  }

  /**
   * Sentinel health verdict for a staging validation or canary step
   * (POST /internal/webhook/sentinel-verdict). Idempotent by commandId: a
   * superseded or older command returns `ignored:stale`.
   */
  async reportSentinelVerdict(input: SentinelVerdict): Promise<ReleaseUpdate> {
    const v = parseOrThrow(SentinelVerdictSchema, input, "sentinel verdict");
    return this.releaseTransition(v.releaseId, (p) => p.sentinelVerdict(v));
  }

  /**
   * Tap to ship (POST /hives/:hive/releases/:releaseId/tap). `user` is the
   * Access-verified email the edge put in `x-queen-user`. Only valid in
   * AWAITING_TAP (CONFLICT otherwise); starts the canary at 1%.
   */
  async tapRelease(input: { releaseId: string; user: string }): Promise<ReleaseUpdate> {
    const releaseId = typeof input?.releaseId === "string" ? input.releaseId.trim() : "";
    const user = typeof input?.user === "string" ? input.user.trim() : "";
    if (!releaseId || releaseId.length > 128) throw new QueenError("INVALID_INPUT", "releaseId is required");
    if (!user || user.length > 320) throw new QueenError("INVALID_INPUT", "user is required");
    const res = await this.releaseTransition(releaseId, (p) => p.tap(releaseId, user));
    if (res.outcome === "conflict") {
      throw new QueenError("CONFLICT", `release ${releaseId} is ${res.release?.phase ?? "unknown"}; only AWAITING_TAP can be tapped`);
    }
    return res;
  }

  /** Cognitive Ledger entry from a drone. */
  async appendAudit(input: AppendAuditInput): Promise<AuditEvent> {
    const a = parseOrThrow(AppendAuditSchema, input, "audit event");
    const notes = a.gitNotesPayload === null ? null : JSON.stringify(a.gitNotesPayload);
    if (notes !== null && new TextEncoder().encode(notes).byteLength > MAX_GIT_NOTES_BYTES) {
      throw new QueenError("INVALID_INPUT", `gitNotesPayload exceeds ${MAX_GIT_NOTES_BYTES} bytes; send a Scribe compaction`);
    }
    if (!this.loadPrompt(a.promptId)) throw new QueenError("NOT_FOUND", `prompt ${a.promptId} not found`);
    const event: AuditEvent = {
      eventId: crypto.randomUUID(),
      promptId: a.promptId,
      droneRole: a.droneRole,
      status: a.status,
      gitNotesPayload: a.gitNotesPayload,
      createdAt: Date.now(),
    };
    this.sql.exec(
      "INSERT INTO audit_trail (event_id, prompt_id, drone_role, status, git_notes_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      event.eventId,
      event.promptId,
      event.droneRole,
      event.status,
      notes,
      event.createdAt,
    );
    this.broadcast({ type: "audit.appended", event });
    return event;
  }

  /** Attach a Scribe compaction (<= 500 chars) to a prompt and/or train. */
  async recordScribeSummary(input: ScribeSummary): Promise<{ promptRun: PromptRun | null; train: MergeTrain | null }> {
    const s = parseOrThrow(ScribeSummarySchema, input, "scribe summary");
    if (!s.promptId && !s.trainId) throw new QueenError("INVALID_INPUT", "promptId or trainId is required");
    const prompt = s.promptId ? this.loadPrompt(s.promptId) : null;
    if (s.promptId && !prompt) throw new QueenError("NOT_FOUND", `prompt ${s.promptId} not found`);
    const train = s.trainId ? this.loadTrain(s.trainId) : null;
    if (s.trainId && !train) throw new QueenError("NOT_FOUND", `train ${s.trainId} not found`);
    this.ctx.storage.transactionSync(() => {
      if (prompt) this.sql.exec("UPDATE prompt_runs SET summary = ? WHERE prompt_id = ?", s.summary, prompt.promptId);
      if (train) this.sql.exec("UPDATE merge_trains SET summary = ? WHERE train_id = ?", s.summary, train.trainId);
    });
    const promptRun = prompt ? toPromptRun(prompt) : null;
    const mergeTrain = train ? toMergeTrain(train) : null;
    if (promptRun) this.broadcast({ type: "prompt.updated", promptRun });
    if (mergeTrain) this.broadcast({ type: "train.updated", train: mergeTrain });
    return { promptRun, train: mergeTrain };
  }

  getSnapshot(): Snapshot {
    const desc = <T>(rows: T[]) => rows.reverse();
    const releases = this.sql
      .exec("SELECT * FROM releases ORDER BY seq DESC LIMIT ?", RELEASE_SNAPSHOT_LIMIT)
      .toArray()
      .map((r) => toRelease(rowToRelease(r)));
    return {
      type: "snapshot",
      promptRuns: desc(
        this.sql.exec("SELECT * FROM prompt_runs ORDER BY seq DESC LIMIT ?", SNAPSHOT_LIMIT).toArray().map(rowToPrompt),
      ).map(toPromptRun),
      trains: desc(
        this.sql.exec("SELECT * FROM merge_trains ORDER BY seq DESC LIMIT ?", SNAPSHOT_LIMIT).toArray().map(rowToTrain),
      ).map(toMergeTrain),
      recentAudit: desc(
        this.sql
          .exec("SELECT * FROM audit_trail ORDER BY created_at DESC, rowid DESC LIMIT ?", AUDIT_SNAPSHOT_LIMIT)
          .toArray()
          .map(rowToAudit),
      ),
      deployments: this.listDeployments(),
      releases,
      verdicts: listVerdicts(this.sql, releases.map((r) => r.releaseId)),
    };
  }

  /** Environment rows plus the newest per-train preview rows, oldest first. */
  listDeployments(): Deployment[] {
    return this.sql
      .exec(
        `SELECT * FROM (SELECT rowid AS rid, * FROM deployments ORDER BY (environment = 'preview'), updated_at DESC, rowid DESC LIMIT ?)
         ORDER BY updated_at, rid`,
        SNAPSHOT_LIMIT,
      )
      .toArray()
      .map(rowToDeployment);
  }

  /**
   * Reconcile fork/delete/dispatch intents that failed or were interrupted,
   * and run the command watchdog (TrainPlanner.reconcile). apply() re-arms
   * the alarm while any command is still outstanding.
   */
  override async alarm(): Promise<void> {
    const hive = this.hiveNamespace();
    if (hive === null) return;
    await this.apply(merged(this.plan(hive, [], (p) => p.reconcile()), this.planRelease(hive, [], (p) => p.reconcile())));
  }

  // ── WebSocket (hibernation API) ───────────────────────────────────────

  override fetch(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response("Too many connections", { status: 503 });
    }
    const hive = request.headers.get(HIVE_HEADER) ?? DEFAULT_HIVE;
    const role = new URL(request.url).searchParams.get("role") === "drone" ? "drone" : "dashboard";
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`role:${role}`, `hive:${hive}`]);
    const attachment: SocketAttachment = {
      id: crypto.randomUUID(),
      role,
      hive,
      subscribed: true,
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);
    this.send(server, this.getSnapshot());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      try {
        ws.close(1009, "message too big");
      } catch {
        /* already closing */
      }
      return;
    }
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === "ping") {
      // Normally answered by the auto-response without waking us.
      this.sendRaw(ws, "pong");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.send(ws, { type: "error", code: "INVALID_INPUT", message: "invalid JSON" });
      return;
    }
    const parsed = QueenClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const err = QueenError.invalid("message", parsed.error.issues);
      this.send(ws, { type: "error", code: err.code, message: err.detail });
      return;
    }
    const att = this.attachment(ws);
    const msg = parsed.data;
    switch (msg.type) {
      case "ping":
        this.send(ws, { type: "pong" });
        return;
      case "subscribe": {
        if (msg.namespace !== undefined && att && msg.namespace !== att.hive) {
          this.send(ws, { type: "error", code: "CONFLICT", message: `this socket is attached to hive "${att.hive}"` });
          return;
        }
        if (att) ws.serializeAttachment({ ...att, subscribed: true } satisfies SocketAttachment);
        this.send(ws, this.getSnapshot());
        return;
      }
      case "submit_prompt": {
        if (att && msg.prompt.namespace !== att.hive) {
          this.send(ws, { type: "error", code: "CONFLICT", message: `this socket is attached to hive "${att.hive}"` });
          return;
        }
        try {
          await this.submitPrompt(msg.prompt);
        } catch (e) {
          const q = asQueenError(e);
          if (!q) console.error("submit_prompt failed", e);
          this.send(ws, { type: "error", code: q?.code ?? "INTERNAL", message: q?.detail ?? "internal error" });
        }
        return;
      }
    }
  }

  override webSocketClose(): void {
    // Compat >= 2026-04-07 auto-replies to the close frame; echoing it back
    // (the old 1005 bug) is neither needed nor safe. Attachments die with the socket.
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    console.error("websocket error", error);
    try {
      ws.close(1011, "websocket error");
    } catch {
      /* socket already closed */
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private hiveNamespace(): string | null {
    const row = this.sql.exec("SELECT namespace FROM prompt_runs LIMIT 1").toArray()[0];
    return row ? String(row.namespace) : null;
  }

  private loadPrompt(promptId: string) {
    const row = this.sql.exec("SELECT * FROM prompt_runs WHERE prompt_id = ?", promptId).toArray()[0];
    return row ? rowToPrompt(row) : null;
  }

  private trainIdForCommand(commandId: string): string | null {
    const row = this.sql
      .exec("SELECT train_id FROM merge_trains WHERE deploy_command_id = ? OR teardown_command_id = ? LIMIT 1", commandId, commandId)
      .toArray()[0];
    return row ? String(row.train_id) : null;
  }

  private releaseIdForCommand(commandId: string): string | null {
    const row = this.sql
      .exec(
        `SELECT release_id FROM releases
         WHERE deploy_command_id = ? OR rollback_command_id = ? OR substr(?, 1, length(release_id) + 1) = release_id || '-'
         ORDER BY seq DESC LIMIT 1`,
        commandId,
        commandId,
        commandId,
      )
      .toArray()[0];
    return row ? String(row.release_id) : null;
  }

  private loadRelease(releaseId: string): ReleaseRecord | null {
    const row = this.sql.exec("SELECT * FROM releases WHERE release_id = ?", releaseId).toArray()[0];
    return row ? rowToRelease(row) : null;
  }

  /** The in-flight release, the newest release, any named ones, and the environment rows. */
  private loadReleaseState(releaseIds: string[]): ReleaseState {
    const named = releaseIds.length ? ` OR release_id IN (${releaseIds.map(() => "?").join(",")})` : "";
    const releases = this.sql
      .exec(
        `SELECT * FROM releases WHERE phase IN ${IN_FLIGHT_SQL} OR seq = (SELECT MAX(seq) FROM releases)${named} ORDER BY seq`,
        ...releaseIds,
      )
      .toArray()
      .map(rowToRelease);
    const deployments = this.sql.exec("SELECT * FROM deployments WHERE environment != 'preview'").toArray().map(rowToDeployment);
    const maxSeq = Number(this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM releases").one().m);
    return { releases, deployments, maxSeq };
  }

  private planRelease(namespace: string, releaseIds: string[], fn: (p: ReleasePlanner) => ReleasePlanResult): ReleasePlanResult {
    const planner = new ReleasePlanner(this.loadReleaseState(releaseIds), {
      namespace,
      now: this.now(),
      newId: () => crypto.randomUUID(),
      commandTimeoutMs: commandTimeoutMs(this.env),
      sentinel: sentinelSettings(this.env),
    });
    return fn(planner);
  }

  private async releaseTransition(releaseId: string, fn: (p: ReleasePlanner) => ReleasePlanResult): Promise<ReleaseUpdate> {
    const hive = this.hiveNamespace();
    if (hive === null || !this.loadRelease(releaseId)) throw new QueenError("NOT_FOUND", `release ${releaseId} not found`);
    const plan = this.planRelease(hive, [releaseId], fn);
    await this.apply(merged(plan));
    const release = this.loadRelease(releaseId);
    return { outcome: plan.outcome, release: release ? toRelease(release) : null };
  }

  private loadTrain(trainId: string) {
    const row = this.sql.exec("SELECT * FROM merge_trains WHERE train_id = ?", trainId).toArray()[0];
    return row ? rowToTrain(row) : null;
  }

  /** Active trains, trains with a pending fork delete or preview teardown, and any explicitly named ones. */
  private loadState(trainIds: string[]): HiveState {
    const named = trainIds.length ? ` OR train_id IN (${trainIds.map(() => "?").join(",")})` : "";
    const cond = `phase NOT IN ('MERGED', 'EJECTED') OR fork_state = 'DELETING' OR deploy_state = 'TEARING_DOWN'${named}`;
    const trains = this.sql
      .exec(`SELECT * FROM merge_trains WHERE ${cond} ORDER BY seq`, ...trainIds)
      .toArray()
      .map(rowToTrain);
    const prompts = this.sql
      .exec(`SELECT * FROM prompt_runs WHERE prompt_id IN (SELECT prompt_id FROM merge_trains WHERE ${cond})`, ...trainIds)
      .toArray()
      .map(rowToPrompt);
    const deployments = this.sql
      .exec(`SELECT * FROM deployments WHERE train_id IN (SELECT train_id FROM merge_trains WHERE ${cond})`, ...trainIds)
      .toArray()
      .map(rowToDeployment);
    const max = (table: string) => Number(this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${table}`).one().m);
    return { prompts, trains, deployments, maxTrainSeq: max("merge_trains"), maxPromptSeq: max("prompt_runs") };
  }

  /** Load -> plan, synchronously (no await), so concurrent calls never interleave mid-plan. */
  private plan(namespace: string, trainIds: string[], fn: (p: TrainPlanner) => PlanResult): PlanResult {
    const planner = new TrainPlanner(this.loadState(trainIds), {
      namespace,
      now: this.now(),
      newId: () => crypto.randomUUID(),
      commandTimeoutMs: commandTimeoutMs(this.env),
    });
    return fn(planner);
  }

  private async trainTransition(
    trainId: string,
    fn: (p: TrainPlanner) => PlanResult,
    then?: (plan: PlanResult, hive: string) => ReleasePlanResult | null,
  ): Promise<TrainUpdate> {
    const hive = this.hiveNamespace();
    if (hive === null || !this.loadTrain(trainId)) throw new QueenError("NOT_FOUND", `train ${trainId} not found`);
    const plan = this.plan(hive, [trainId], fn);
    // Still synchronous: the release decision sees the same state and commits with the train's.
    await this.apply(merged(plan, then?.(plan, hive) ?? null));
    const train = this.loadTrain(trainId);
    return { outcome: plan.outcome, train: train ? toMergeTrain(train) : null };
  }

  /**
   * Persist first (one transaction), then broadcast, then dispatch commands
   * outside any transaction. Command ids are already durable on the train
   * rows, so a crash between steps is repaired by the reconcile alarm, and a
   * re-dispatch of the same command id is a no-op.
   */
  private async apply(plan: Persist): Promise<void> {
    if (plan.prompts.length || plan.trains.length || plan.deployments.length || plan.releases.length) {
      this.ctx.storage.transactionSync(() => {
        for (const p of plan.prompts) upsertPrompt(this.sql, p);
        for (const t of plan.trains) upsertTrain(this.sql, t);
        for (const d of plan.deployments) upsertDeployment(this.sql, d);
        for (const r of plan.releases) upsertRelease(this.sql, r);
        for (const e of plan.effects) if (e.type === "broadcast" && e.message.type === "sentinel.verdict") upsertVerdict(this.sql, e.message.verdict, this.now());
      });
    }
    for (const e of plan.effects) if (e.type === "broadcast") this.broadcast(e.message);
    for (const e of plan.effects) if (e.type !== "broadcast") await this.execute(e);
    await this.armWatchdog();
  }

  /**
   * Keep the alarm armed while any command is outstanding: at the earliest
   * watchdog deadline (issuedAt + COMMAND_TIMEOUT_MS). Only ever moves an
   * existing alarm earlier (the reconcile retry and the sim share it).
   */
  private async armWatchdog(): Promise<void> {
    if (this.hiveNamespace() === null) return;
    const now = this.now();
    const timeout = commandTimeoutMs(this.env);
    const deadlines = [
      watchdogDeadline(this.loadState([]).trains, timeout, now),
      releaseWatchdogDeadline(this.loadReleaseState([]).releases, timeout, sentinelSettings(this.env).windowSeconds, now),
    ].filter((d): d is number => d !== null);
    if (!deadlines.length) return;
    const due = Math.min(...deadlines);
    // Real time for the alarm itself; `now()` may be skewed by tests.
    const at = Date.now() + Math.max(0, due - now) + WATCHDOG_SLACK_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  private async execute(e: Exclude<Effect | ReleaseEffect, { type: "broadcast" }>): Promise<void> {
    switch (e.type) {
      case "provision": {
        // Async: the Provisioner reports back via reportProvisionResult.
        try {
          await this.ports.provisioner.dispatch(e.command);
        } catch (err) {
          return this.ioFailed(e, err);
        }
        return;
      }
      case "deploy": {
        // Async: the Herald reports back via reportDeployResult.
        try {
          await this.ports.herald.dispatch(e.command);
        } catch (err) {
          return this.ioFailed(e, err);
        }
        return;
      }
      case "sentinel": {
        // Async: the Sentinel reports back via reportSentinelVerdict.
        try {
          await this.ports.sentinel.dispatch(e.command);
        } catch (err) {
          return this.ioFailed(e, err);
        }
        return;
      }
      case "dispatchDrone": {
        try {
          await this.ports.dispatcher.dispatch(e.task, e.attempt);
        } catch (err) {
          return this.ioFailed(e, err);
        }
        const hive = this.hiveNamespace()!;
        const phase = e.task.action === "LAND" ? "LANDING" : "BUILDING";
        await this.apply(merged(this.plan(hive, [e.trainId], (p) => p.dispatched(e.trainId, phase))));
        return;
      }
    }
  }

  private async ioFailed(e: Effect | ReleaseEffect, err: unknown): Promise<void> {
    console.error(`queen: ${e.type} failed; reconciling in ${RECONCILE_DELAY_MS} ms`, err);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + RECONCILE_DELAY_MS);
    }
  }

  private attachment(ws: WebSocket): SocketAttachment | null {
    try {
      return (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
    } catch {
      return null;
    }
  }

  private broadcast(message: QueenServerMessage): void {
    const frame = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue; // getWebSockets may include CLOSING sockets
      if (!this.attachment(ws)?.subscribed) continue;
      this.sendRaw(ws, frame);
    }
  }

  private send(ws: WebSocket, message: QueenServerMessage): void {
    this.sendRaw(ws, JSON.stringify(message));
  }

  private sendRaw(ws: WebSocket, frame: string): void {
    try {
      ws.send(frame);
    } catch (err) {
      console.warn("queen: dropping frame for a dead socket", err);
    }
  }
}
