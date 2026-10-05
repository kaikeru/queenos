/**
 * GenesisNode: one Durable Object per hive (idFromName(hive)) holding the
 * onboarding wizard. SQLite-backed and fully persisted, so a reopened wizard
 * resumes where it was.
 *
 *   DESCRIBE -> CHARTER_READY -> DEPLOY_CONNECTED -> HIVE_CREATING -> FIRST_FLIGHT -> ACTIVE
 *                                                          \________ FAILED (relaunchable) ________/
 *
 * Errors thrown over RPC carry a code prefix ("INVALID_INPUT: ...", "NOT_FOUND:",
 * "CONFLICT:", "UNAVAILABLE:"); the HTTP layer maps them to statuses.
 */
import { DurableObject } from "cloudflare:workers";
import {
  CharterSchema,
  HiveCreatedResultSchema,
  HiveSlugSchema,
  type Charter,
  type ChatMessage,
  type HiveCreatedResult,
  type VaultStatus,
  type WizardState,
  type WizardStep,
} from "@queenos/queen-types";
import {
  baseDraft,
  capHistory,
  mergeDraft,
  parseModelOutput,
  scriptedInterview,
  SYSTEM_PROMPT,
  type Draft,
  type InterviewResult,
} from "./interview";
import { createProdPorts, devFakesProvisioner, loadConfig, type GenesisConfig, type GenesisPorts } from "./ports";
import { findSecret, SECRET_PLACEHOLDER, SECRET_REFUSAL } from "./secrets";

export class GenesisError extends Error {
  override readonly name = "GenesisError";
  constructor(
    readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const MAX_MESSAGES = 200;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

interface Record_ {
  hive: string;
  name: string;
  createdBy: string;
  step: WizardStep;
  messages: ChatMessage[];
  draft: Draft;
  charter: Charter | null;
  vault: VaultStatus | null;
  previewUrl: string | null;
  lastError: string | null;
  /** Current CREATE_HIVE command (Workflow instance id). A relaunch mints a new one. */
  commandId: string | null;
  attempt: number;
  /** Epoch ms of the current launch; the 10-minute budget runs from here. */
  launchedAt: number | null;
  /** The accepted report for `commandId` (idempotency). */
  reported: { ok: boolean; mainSha?: string } | null;
  promptId: string | null;
  updatedAt: number;
}

export type ReportOutcome = { outcome: "applied" | "duplicate" | "ignored" };

export class GenesisNode extends DurableObject<Env> {
  private readonly config: GenesisConfig;
  private readonly ports: GenesisPorts;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = loadConfig(env as unknown as Record<string, unknown>);
    this.ports = this.createPorts(env, this.config);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS wizard (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)");
  }

  /** Seam for tests: override to inject fake Registry / Vault / Queen / Provisioner / LLM ports. */
  protected createPorts(env: Env, config: GenesisConfig): GenesisPorts {
    const ports = createProdPorts(env as never, config);
    if (!devFakesProvisioner(env as never)) return ports;
    // DEV ONLY: no Artifacts locally. Pretend the Provisioner finished CREATE_HIVE after a short delay.
    ports.provisioner = {
      createHive: async (cmd) => {
        this.ctx.waitUntil(
          new Promise<void>((resolve) => setTimeout(resolve, 1_500)).then(async () => {
            await this.reportHiveCreated({ commandId: cmd.commandId, hive: cmd.hive, ok: true, mainSha: "dev-fake-sha" });
          }),
        );
      },
    };
    return ports;
  }

  // ── persistence ───────────────────────────────────────────────────────

  private load(): Record_ | null {
    const row = this.ctx.storage.sql.exec<{ json: string }>("SELECT json FROM wizard WHERE id = 1").toArray()[0];
    return row ? (JSON.parse(row.json) as Record_) : null;
  }

  private need(): Record_ {
    const r = this.load();
    if (!r) throw new GenesisError("NOT_FOUND", "no such project");
    return r;
  }

  private save(r: Record_): void {
    r.updatedAt = this.ports.now();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO wizard (id, json) VALUES (1, ?)", JSON.stringify(r));
  }

  private view(r: Record_): WizardState {
    return {
      hive: r.hive,
      step: r.step,
      messages: r.messages,
      charterDraft: (r.charter as Record<string, unknown> | null) ?? r.draft,
      vault: r.vault,
      previewUrl: r.previewUrl,
      lastError: r.lastError ? clip(r.lastError, 500) : null,
      updatedAt: r.updatedAt,
    };
  }

  // ── RPC: wizard ───────────────────────────────────────────────────────

  /** Start (or resume) a project. Registers it as ONBOARDING. */
  async start(input: { hive: string; name: string; createdBy: string }): Promise<WizardState> {
    const hive = parse(HiveSlugSchema.safeParse(input.hive), "hive");
    const existing = this.load();
    if (existing) return this.view(existing);
    try {
      await this.ports.registry.register({ hive, name: input.name, description: "", createdBy: input.createdBy });
    } catch (e) {
      throw registryError(e);
    }
    const r: Record_ = {
      hive,
      name: input.name,
      createdBy: input.createdBy,
      step: "DESCRIBE",
      messages: [],
      draft: baseDraft(hive, input.name),
      charter: null,
      vault: null,
      previewUrl: null,
      lastError: null,
      commandId: null,
      attempt: 0,
      launchedAt: null,
      reported: null,
      promptId: null,
      updatedAt: 0,
    };
    this.save(r);
    return this.view(r);
  }

  /** Current state. Re-reads the Vault, which may advance CHARTER_READY -> DEPLOY_CONNECTED. */
  async getState(): Promise<WizardState> {
    const r = this.need();
    await this.refreshVault(r);
    return this.view(r);
  }

  /** A user message in the DESCRIBE interview. */
  async postMessage(input: { text: string }): Promise<WizardState> {
    const text = input.text.trim();
    if (!text) throw new GenesisError("INVALID_INPUT", "text is empty");
    let r = this.need();
    if (r.step !== "DESCRIBE") throw new GenesisError("CONFLICT", `the interview is over (step ${r.step})`);

    // Secrets never reach the model or storage; the Connect form is the only path.
    if (findSecret(text)) {
      const at = this.ports.now();
      r.messages.push({ role: "user", content: SECRET_PLACEHOLDER, at }, { role: "assistant", content: SECRET_REFUSAL, at });
      this.save(r);
      return this.view(r);
    }

    const userTurn = r.messages.filter((m) => m.role === "user").length + 1;
    const history = capHistory([...r.messages, { role: "user", content: text, at: 0 }]);
    const result = await this.interview(r, userTurn, text, history);

    r = this.need(); // another call may have run while the model thought
    const at = this.ports.now();
    r.messages.push({ role: "user", content: clip(text, 4_000), at }, { role: "assistant", content: result.reply, at });
    if (r.messages.length > MAX_MESSAGES) r.messages = r.messages.slice(-MAX_MESSAGES);
    r.draft = mergeDraft(r.draft, result.patch);
    this.save(r);
    return this.view(r);
  }

  private async interview(r: Record_, userTurn: number, text: string, history: ReturnType<typeof capHistory>): Promise<InterviewResult> {
    if (this.config.llmMode === "scripted" || !this.ports.llm) return scriptedInterview(r.draft, userTurn, text);
    const draftSoFar = JSON.stringify({ name: r.draft.name, description: r.draft.description, policy: r.draft.policy, firstPrompt: r.draft.firstPrompt });
    try {
      const out = await this.ports.llm.complete({
        model: this.config.model,
        system: `${SYSTEM_PROMPT}\n\nProject name: ${r.name}\nCurrent charter draft: ${draftSoFar}`,
        messages: history,
        // Reasoning models (GLM) think before answering; leave room for both.
        maxTokens: 6_000,
        metadata: { app: "genesis", hive: r.hive },
      });
      return parseModelOutput(out.text);
    } catch (e) {
      throw new GenesisError("UNAVAILABLE", `the interviewer is unavailable, try again: ${clip(messageOf(e), 200)}`);
    }
  }

  /** The user's confirmed charter. DESCRIBE -> CHARTER_READY. */
  async putCharter(input: { charter: unknown }): Promise<WizardState> {
    const charter = parse(CharterSchema.safeParse(input.charter), "charter");
    const r = this.need();
    if (charter.hive !== r.hive) throw new GenesisError("INVALID_INPUT", `charter.hive must be "${r.hive}"`);
    if (r.step !== "DESCRIBE" && r.step !== "CHARTER_READY" && r.step !== "DEPLOY_CONNECTED") {
      throw new GenesisError("CONFLICT", `the charter is locked once launched (step ${r.step})`);
    }
    if (findSecret(JSON.stringify(charter))) {
      throw new GenesisError("INVALID_INPUT", "the charter looks like it contains a secret; use the Connect form for credentials");
    }
    r.charter = charter;
    r.draft = charter as unknown as Draft;
    r.name = charter.name;
    if (r.step === "DESCRIBE") r.step = "CHARTER_READY";
    this.save(r);
    try {
      await this.ports.registry.update(r.hive, { name: charter.name, description: clip(charter.description, 2_000) });
    } catch {
      /* cosmetic: the projects list catches up on the next update */
    }
    await this.refreshVault(r);
    return this.view(r);
  }

  /** Dispatch CREATE_HIVE. Requires DEPLOY_CONNECTED; a FAILED launch can be retried. */
  async launch(): Promise<WizardState> {
    const r = this.need();
    if (r.step === "HIVE_CREATING" || r.step === "FIRST_FLIGHT" || r.step === "ACTIVE") return this.view(r); // idempotent
    await this.refreshVault(r);
    const relaunch = r.step === "FAILED";
    if (!r.charter) throw new GenesisError("CONFLICT", "confirm the charter first");
    if (!r.vault?.connected) throw new GenesisError("CONFLICT", "connect Cloudflare first");
    if (r.step !== "DEPLOY_CONNECTED" && !relaunch) throw new GenesisError("CONFLICT", `cannot launch from ${r.step}`);

    r.attempt += 1;
    r.commandId = `genesis-${r.hive}-${r.attempt}-${this.ports.randomId().replace(/-/g, "").slice(0, 12)}`;
    r.launchedAt = this.ports.now();
    r.reported = null;
    r.promptId = null;
    r.previewUrl = null;
    r.lastError = null;
    r.step = "HIVE_CREATING";
    this.save(r);
    if (relaunch) await this.registryStatus(r, "ONBOARDING");
    await this.ctx.storage.setAlarm(this.ports.now() + this.config.pollMs);

    try {
      await this.ports.provisioner.createHive({
        op: "CREATE_HIVE",
        commandId: r.commandId,
        hive: r.hive,
        template: "worker-starter",
        charterJson: JSON.stringify(r.charter),
      });
    } catch (e) {
      await this.fail(r, `could not start repository creation: ${messageOf(e)}`);
    }
    return this.view(this.need());
  }

  // ── RPC: Provisioner callback ─────────────────────────────────────────

  /** The Provisioner's CREATE_HIVE outcome. Idempotent per commandId. */
  async reportHiveCreated(input: HiveCreatedResult): Promise<ReportOutcome> {
    const res = parse(HiveCreatedResultSchema.safeParse(input), "HiveCreatedResult");
    const r = this.need();
    if (res.hive !== r.hive) throw new GenesisError("INVALID_INPUT", `result is for ${res.hive}, not ${r.hive}`);
    if (res.commandId !== r.commandId) return { outcome: "ignored" }; // an older launch
    if (r.reported) return { outcome: "duplicate" };
    if (r.step !== "HIVE_CREATING") return { outcome: "ignored" }; // e.g. already timed out

    r.reported = { ok: res.ok, ...(res.mainSha ? { mainSha: res.mainSha } : {}) };
    if (!res.ok) {
      await this.fail(r, res.summary ?? "repository creation failed");
      return { outcome: "applied" };
    }
    r.step = "FIRST_FLIGHT";
    this.save(r);
    try {
      const run = await this.ports.queen(r.hive).submitPrompt({ namespace: r.hive, promptText: r.charter!.firstPrompt });
      r.promptId = run.promptId;
      this.save(r);
    } catch (e) {
      // Reported, so do not make the Provisioner retry: surface it and let the user relaunch.
      await this.fail(r, `could not submit the first prompt: ${messageOf(e)}`);
      return { outcome: "applied" };
    }
    await this.ctx.storage.setAlarm(this.ports.now() + this.config.pollMs);
    return { outcome: "applied" };
  }

  // ── alarm: first-flight polling and the launch timeout ────────────────

  override async alarm(): Promise<void> {
    const r = this.load();
    if (!r || (r.step !== "HIVE_CREATING" && r.step !== "FIRST_FLIGHT")) return;
    const now = this.ports.now();
    if (r.launchedAt !== null && now - r.launchedAt > this.config.launchTimeoutMs) {
      const stage = r.step === "HIVE_CREATING" ? "creating the repository" : "waiting for the first preview";
      await this.fail(r, `timed out after ${Math.round(this.config.launchTimeoutMs / 60_000)} minutes ${stage}`);
      return;
    }
    if (r.step === "FIRST_FLIGHT") {
      try {
        const snap = await this.ports.queen(r.hive).getSnapshot();
        const url = firstPreviewUrl(snap.trains, r.promptId);
        if (url) {
          await this.ports.registry.update(r.hive, { status: "ACTIVE", urls: { preview: url } });
          const fresh = this.need();
          fresh.previewUrl = url;
          fresh.step = "ACTIVE";
          fresh.lastError = null;
          this.save(fresh);
          return;
        }
      } catch {
        /* transient: try again on the next tick */
      }
    }
    await this.ctx.storage.setAlarm(now + this.config.pollMs);
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /** Re-read Vault status (keeping the last known value on error) and advance the step. */
  private async refreshVault(r: Record_): Promise<void> {
    try {
      r.vault = await this.ports.vault.status(r.hive);
    } catch {
      /* keep the cached status */
    }
    if (r.step === "CHARTER_READY" && r.vault?.connected) r.step = "DEPLOY_CONNECTED";
    this.save(r);
  }

  private async fail(r: Record_, why: string): Promise<void> {
    const fresh = this.load() ?? r;
    fresh.step = "FAILED";
    fresh.lastError = clip(why, 500);
    fresh.reported = r.reported;
    this.save(fresh);
    await this.registryStatus(fresh, "FAILED");
  }

  private async registryStatus(r: Record_, status: "ONBOARDING" | "FAILED"): Promise<void> {
    try {
      await this.ports.registry.update(r.hive, { status });
    } catch {
      /* best effort */
    }
  }
}

/** The first train's preview URL: the train that includes the first prompt, else any train with one. */
function firstPreviewUrl(trains: { includedPrompts: string[]; previewUrl?: string | null | undefined; createdAt: number }[], promptId: string | null): string | null {
  const withUrl = trains.filter((t) => t.previewUrl);
  const mine = promptId ? withUrl.filter((t) => t.includedPrompts.includes(promptId)) : withUrl;
  const first = [...mine].sort((a, b) => a.createdAt - b.createdAt)[0];
  return first?.previewUrl ?? null;
}

function parse<T>(r: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }, what: string): T {
  if (r.success) return r.data;
  const detail = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || what}: ${i.message}`).join("; ");
  throw new GenesisError("INVALID_INPUT", `invalid ${what}: ${detail}`);
}

function registryError(e: unknown): GenesisError {
  const m = messageOf(e);
  if (/CONFLICT/.test(m)) return new GenesisError("CONFLICT", `project already exists: ${clip(m, 200)}`);
  if (/INVALID/.test(m)) return new GenesisError("INVALID_INPUT", clip(m, 200));
  return new GenesisError("UNAVAILABLE", `registry unavailable: ${clip(m, 200)}`);
}
