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
  type ScribeSummary,
  type SubmitPrompt,
  type TrainResult,
} from "@queenos/queen-types";
import {
  migrate,
  rowToAudit,
  rowToDeployment,
  rowToPrompt,
  rowToTrain,
  upsertDeployment,
  upsertPrompt,
  upsertTrain,
} from "./db";
import { WorkflowDroneDispatcher, type DroneDispatcher } from "./drones";
import { WorkflowCommandDispatcher, type DeployDispatcher, type ProvisionerDispatcher } from "./executors";
import { QueenError, asQueenError, parseOrThrow } from "./errors";
import {
  TrainPlanner,
  toMergeTrain,
  toPromptRun,
  type Effect,
  type HiveState,
  type Outcome,
  type PlanResult,
} from "./train/planner";

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
const SNAPSHOT_LIMIT = 200;
const AUDIT_SNAPSHOT_LIMIT = 50;

export interface QueenPorts {
  /** Provisioner Workflow (FORK / DELETE). */
  provisioner: ProvisionerDispatcher;
  /** Herald Workflow (DEPLOY / TEARDOWN / ROLLBACK). */
  herald: DeployDispatcher;
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

  /** Seam for tests and sim: override to inject fake executor / drone ports. */
  protected createPorts(env: Env): QueenPorts {
    return {
      provisioner: new WorkflowCommandDispatcher(env.PROVISIONER, "PROVISIONER"),
      herald: new WorkflowCommandDispatcher(env.HERALD, "HERALD"),
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
    await this.apply(this.plan(prompt.namespace, [], (p) => p.submit({ promptId, promptText: prompt.promptText })));
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

  /** Lander pushed (or failed to push) the head to main (POST /internal/webhook/land-result). */
  async reportLandResult(input: LandResultInput): Promise<TrainUpdate> {
    const r = parseOrThrow(LandResultSchema, input, "land result");
    return this.trainTransition(r.trainId, (p) => p.landResult(r));
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
   * Herald outcome for a preview DEPLOY or TEARDOWN command
   * (POST /internal/webhook/deploy-result). Idempotent by commandId. The train
   * is resolved from `trainId`, or else from the command id.
   */
  async reportDeployResult(input: DeployResult): Promise<TrainUpdate> {
    const r = parseOrThrow(DeployResultSchema, input, "deploy result");
    const trainId = r.trainId ?? this.trainIdForCommand(r.commandId);
    if (!trainId) throw new QueenError("NOT_FOUND", `no train for command ${r.commandId}`);
    return this.trainTransition(trainId, (p) => p.deployResult({ ...r, trainId }));
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

  /** Reconcile fork/delete/dispatch intents that failed or were interrupted. */
  override async alarm(): Promise<void> {
    const hive = this.hiveNamespace();
    if (hive === null) return;
    await this.apply(this.plan(hive, [], (p) => p.reconcile()));
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
      now: Date.now(),
      newId: () => crypto.randomUUID(),
    });
    return fn(planner);
  }

  private async trainTransition(trainId: string, fn: (p: TrainPlanner) => PlanResult): Promise<TrainUpdate> {
    const hive = this.hiveNamespace();
    if (hive === null || !this.loadTrain(trainId)) throw new QueenError("NOT_FOUND", `train ${trainId} not found`);
    const plan = this.plan(hive, [trainId], fn);
    await this.apply(plan);
    const train = this.loadTrain(trainId);
    return { outcome: plan.outcome, train: train ? toMergeTrain(train) : null };
  }

  /**
   * Persist first (one transaction), then broadcast, then dispatch commands
   * outside any transaction. Command ids are already durable on the train
   * rows, so a crash between steps is repaired by the reconcile alarm, and a
   * re-dispatch of the same command id is a no-op.
   */
  private async apply(plan: PlanResult): Promise<void> {
    if (plan.prompts.length || plan.trains.length || plan.deployments.length) {
      this.ctx.storage.transactionSync(() => {
        for (const p of plan.prompts) upsertPrompt(this.sql, p);
        for (const t of plan.trains) upsertTrain(this.sql, t);
        for (const d of plan.deployments) upsertDeployment(this.sql, d);
      });
    }
    for (const e of plan.effects) if (e.type === "broadcast") this.broadcast(e.message);
    for (const e of plan.effects) if (e.type !== "broadcast") await this.execute(e);
  }

  private async execute(e: Exclude<Effect, { type: "broadcast" }>): Promise<void> {
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
      case "dispatchDrone": {
        try {
          await this.ports.dispatcher.dispatch(e.task);
        } catch (err) {
          return this.ioFailed(e, err);
        }
        const hive = this.hiveNamespace()!;
        const phase = e.task.action === "LAND" ? "LANDING" : "BUILDING";
        await this.apply(this.plan(hive, [e.trainId], (p) => p.dispatched(e.trainId, phase)));
        return;
      }
    }
  }

  private async ioFailed(e: Effect, err: unknown): Promise<void> {
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
