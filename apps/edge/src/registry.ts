import { DurableObject } from "cloudflare:workers";
import { HiveSlugSchema, type GitTokenAgent, type Project } from "@queenos/queen-types";

type Patch = { status?: Project["status"]; name?: string; description?: string; urls?: Partial<Project["urls"]> };

interface Row extends Record<string, SqlStorageValue> {
  hive: string;
  name: string;
  description: string;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  urls: string;
}

function toProject(r: Row): Project {
  return {
    hive: r.hive,
    name: r.name,
    description: r.description,
    status: r.status as Project["status"],
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    urls: JSON.parse(r.urls) as Project["urls"],
  };
}

export interface GitTokenInfo {
  id: string;
  email: string;
  scopes: ("read" | "push")[];
  label: string | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** The agent the token is bound to (name + self-reported model); null for a plain human token. */
  agent: GitTokenAgent | null;
}

interface TokenRow extends Record<string, SqlStorageValue> {
  id: string;
  email: string;
  scopes: string;
  label: string | null;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  agent_name: string | null;
  agent_model: string | null;
}

function toToken(r: TokenRow): GitTokenInfo {
  return {
    id: r.id,
    email: r.email,
    scopes: r.scopes.split(",") as GitTokenInfo["scopes"],
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    agent: r.agent_name ? { name: r.agent_name, model: r.agent_model ?? null } : null,
  };
}

/** Adds the agent columns to a `git_tokens` table created before agent identity existed. Idempotent. */
export function migrateGitTokens(sql: SqlStorage): void {
  const cols = new Set(sql.exec<{ name: string }>("PRAGMA table_info(git_tokens)").toArray().map((c) => c.name));
  if (!cols.has("agent_name")) sql.exec("ALTER TABLE git_tokens ADD COLUMN agent_name TEXT");
  if (!cols.has("agent_model")) sql.exec("ALTER TABLE git_tokens ADD COLUMN agent_model TEXT");
}

/** Failed git auth: at most this many per key per window. */
export const GIT_FAIL_LIMIT = 10;
export const GIT_FAIL_WINDOW_MS = 5 * 60_000;
const LAST_USED_GRANULARITY_MS = 60_000;

/**
 * Project registry: one instance (idFromName("registry")). Orchestration
 * metadata only. Errors carry a code prefix: "CONFLICT:", "NOT_FOUND:", "INVALID:".
 */
export class HiveRegistry extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS projects (
      hive TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, urls TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS git_tokens (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, label TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`);
    migrateGitTokens(ctx.storage.sql);
    ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS git_tokens_email ON git_tokens (email)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS git_auth_fails (
      key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)`);
  }

  private row(hive: string): Row | undefined {
    return this.ctx.storage.sql.exec<Row>("SELECT * FROM projects WHERE hive = ?", hive).toArray()[0];
  }

  async register(input: { hive: string; name: string; description: string; createdBy: string }): Promise<Project> {
    if (!HiveSlugSchema.safeParse(input.hive).success) throw new Error("INVALID: bad hive slug");
    const existing = this.row(input.hive);
    if (existing) {
      if (existing.created_by !== input.createdBy) throw new Error(`CONFLICT: hive ${input.hive} already exists`);
      return toProject(existing);
    }
    const t = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO projects (hive, name, description, status, created_by, created_at, updated_at, urls) VALUES (?, ?, ?, 'ONBOARDING', ?, ?, ?, ?)",
      input.hive,
      input.name,
      input.description,
      input.createdBy,
      t,
      t,
      JSON.stringify({ prod: null, staging: null, preview: null }),
    );
    return toProject(this.row(input.hive)!);
  }

  async update(hive: string, patch: Patch): Promise<Project> {
    const cur = this.row(hive);
    if (!cur) throw new Error(`NOT_FOUND: hive ${hive}`);
    const urls = { ...(JSON.parse(cur.urls) as Project["urls"]), ...(patch.urls ?? {}) };
    this.ctx.storage.sql.exec(
      "UPDATE projects SET status = ?, name = ?, description = ?, urls = ?, updated_at = ? WHERE hive = ?",
      patch.status ?? cur.status,
      patch.name ?? cur.name,
      patch.description ?? cur.description,
      JSON.stringify(urls),
      Date.now(),
      hive,
    );
    return toProject(this.row(hive)!);
  }

  async list(): Promise<Project[]> {
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM projects ORDER BY created_at DESC, hive ASC")
      .toArray()
      .map(toProject);
  }

  async get(hive: string): Promise<Project | null> {
    const r = this.row(hive);
    return r ? toProject(r) : null;
  }

  // ---- Git tokens (only the SHA-256 is stored) ----

  async mintGitToken(input: {
    id: string;
    hash: string;
    email: string;
    scopes: ("read" | "push")[];
    label: string | null;
    ttlMs: number;
    /** Optional: tokens minted without an agent are plain human tokens. */
    agent?: GitTokenAgent | null;
  }): Promise<GitTokenInfo> {
    const t = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO git_tokens (id, email, hash, scopes, label, created_at, expires_at, agent_name, agent_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.id,
      input.email,
      input.hash,
      input.scopes.join(","),
      input.label,
      t,
      t + input.ttlMs,
      input.agent?.name ?? null,
      input.agent ? (input.agent.model ?? null) : null,
    );
    return toToken(this.ctx.storage.sql.exec<TokenRow>("SELECT * FROM git_tokens WHERE id = ?", input.id).one());
  }

  async listGitTokens(email: string): Promise<GitTokenInfo[]> {
    return this.ctx.storage.sql
      .exec<TokenRow>("SELECT * FROM git_tokens WHERE email = ? ORDER BY created_at DESC, id ASC", email)
      .toArray()
      .map(toToken);
  }

  /** Revokes the caller's own token. Returns false when there is no such token. */
  async revokeGitToken(id: string, email: string): Promise<boolean> {
    const rows = this.ctx.storage.sql
      .exec<TokenRow>("SELECT * FROM git_tokens WHERE id = ? AND email = ?", id, email)
      .toArray();
    if (rows.length === 0) return false;
    this.ctx.storage.sql.exec(
      "UPDATE git_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      Date.now(),
      id,
    );
    return true;
  }

  /** Checked on every git request: revocation and expiry take effect immediately. */
  async authGitToken(hash: string): Promise<{
    id: string;
    email: string;
    scopes: ("read" | "push")[];
    agent: GitTokenAgent | null;
  } | null> {
    const r = this.ctx.storage.sql.exec<TokenRow>("SELECT * FROM git_tokens WHERE hash = ?", hash).toArray()[0];
    if (!r || r.revoked_at !== null) return null;
    const t = Date.now();
    if (r.expires_at <= t) return null;
    if (r.last_used_at === null || t - r.last_used_at >= LAST_USED_GRANULARITY_MS) {
      this.ctx.storage.sql.exec("UPDATE git_tokens SET last_used_at = ? WHERE id = ?", t, r.id);
    }
    return {
      id: r.id,
      email: r.email,
      scopes: r.scopes.split(",") as ("read" | "push")[],
      agent: r.agent_name ? { name: r.agent_name, model: r.agent_model ?? null } : null,
    };
  }

  // ---- Failed git auth rate limit (fixed window per key) ----

  /** Seconds until retry when any key is over the limit, else 0. */
  async gitAuthBlocked(keys: string[]): Promise<number> {
    const t = Date.now();
    let wait = 0;
    for (const key of keys) {
      const r = this.ctx.storage.sql
        .exec<{ window_start: number; count: number }>("SELECT window_start, count FROM git_auth_fails WHERE key = ?", key)
        .toArray()[0];
      if (r && t - r.window_start < GIT_FAIL_WINDOW_MS && r.count >= GIT_FAIL_LIMIT) {
        wait = Math.max(wait, Math.ceil((r.window_start + GIT_FAIL_WINDOW_MS - t) / 1000));
      }
    }
    return wait;
  }

  async gitAuthFailed(keys: string[]): Promise<void> {
    const t = Date.now();
    for (const key of keys) {
      const r = this.ctx.storage.sql
        .exec<{ window_start: number; count: number }>("SELECT window_start, count FROM git_auth_fails WHERE key = ?", key)
        .toArray()[0];
      if (!r || t - r.window_start >= GIT_FAIL_WINDOW_MS) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO git_auth_fails (key, window_start, count) VALUES (?, ?, 1)",
          key,
          t,
        );
      } else {
        this.ctx.storage.sql.exec("UPDATE git_auth_fails SET count = count + 1 WHERE key = ?", key);
      }
    }
    // Opportunistic cleanup keeps the table small.
    this.ctx.storage.sql.exec("DELETE FROM git_auth_fails WHERE window_start < ?", t - GIT_FAIL_WINDOW_MS);
  }
}
