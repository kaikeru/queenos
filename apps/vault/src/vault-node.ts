/**
 * VaultNode: one SQLite Durable Object per hive (`VAULT_NODE.idFromName(hive)`),
 * so a hive's DEK, ciphertexts and audit trail are isolated from every other
 * hive's, and a bug in one call cannot read another hive's rows.
 *
 * Only this Worker binds VaultNode. Other Workers reach it through the named
 * entrypoints in index.ts (VaultWriter for the edge, VaultReader for the
 * Herald); the Queen binds neither.
 *
 * Stored per hive: the AES-KW-wrapped DEK plus its KEK version, and per secret
 * the AES-GCM ciphertext, IV and version, plus non-secret metadata for status
 * (account id, verifiedAt, redacted check results). Never a plaintext value.
 */
import { DurableObject } from "cloudflare:workers";
import type { CloudflareFetch } from "@queenos/hive-kit";
import { ConnectCloudflareSchema, HiveSlugSchema, type ConnectCloudflare, type VaultStatus } from "@queenos/queen-types";
import {
  aadFor,
  decodeJson,
  encodeJson,
  keyringFromEnv,
  newWrappedDek,
  open,
  seal,
  unwrapDek,
  type Keyring,
  type WrappedDek,
} from "./envelope";
import { cloudflareFetchFor } from "./dev-fetch";
import { verifyCloudflare, type CloudflareCheck } from "./verify";

export const CLOUDFLARE_SECRET = "cloudflare";
/** Audit label for VaultReader calls. Only the Herald binds VaultReader. */
export const READER_CALLER = "herald (VaultReader)";
const MAX_PURPOSE = 200;
const MAX_ACTOR = 320;

export interface CloudflareCredential {
  accountId: string;
  apiToken: string;
}

export interface VaultEnv {
  VAULT_NODE: DurableObjectNamespace<VaultNode>;
  VAULT_KEK?: string;
  VAULT_KEK_PREVIOUS?: string;
  /** DEV ONLY (.dev.vars): base URL of a fake Cloudflare API. See dev-fetch.ts. */
  VAULT_DEV_CF_BASE?: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS deks (
    hive TEXT PRIMARY KEY,
    wrapped_dek BLOB NOT NULL,      -- AES-KW(KEK, DEK), 40 bytes
    kek_version TEXT NOT NULL,      -- KEK fingerprint (envelope.ts)
    created_at INTEGER NOT NULL,
    rewrapped_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS secrets (
    hive TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,       -- part of the AAD; +1 on every write
    iv BLOB NOT NULL,               -- 12 random bytes
    ct BLOB NOT NULL,               -- AES-GCM(DEK, iv, aad = hive|name|version) incl. 16-byte tag
    account_id TEXT,                -- public metadata for status
    verified_at INTEGER,
    checks TEXT,                    -- JSON, redacted check results
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    PRIMARY KEY (hive, name)
  );
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hive TEXT NOT NULL,
    secret TEXT NOT NULL,
    action TEXT NOT NULL,           -- connect | connect_rejected | reveal | reveal_denied
    actor TEXT NOT NULL,            -- user email (writer) or caller label (reader)
    purpose TEXT,
    ok INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
`;

function assertHive(hive: unknown): string {
  const r = HiveSlugSchema.safeParse(hive);
  if (!r.success) throw new Error("INVALID_INPUT: hive must be a lowercase slug (3-32 chars)");
  return r.data;
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n));

export class VaultNode extends DurableObject<VaultEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: VaultEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  /** Seam for tests: the Cloudflare API fetch used by verification. */
  protected cloudflareFetch(): CloudflareFetch {
    return cloudflareFetchFor(this.env.VAULT_DEV_CF_BASE);
  }

  /** Seam for tests: the KEK keyring (default: VAULT_KEK / VAULT_KEK_PREVIOUS). */
  protected keyring(): Promise<Keyring> {
    return keyringFromEnv(this.env);
  }

  // ── writer ────────────────────────────────────────────────────────────

  /**
   * Verify, then (only on success) encrypt and store the hive's Cloudflare
   * credential. A failed verification stores nothing and returns
   * `connected:false` with the checks.
   */
  async connectCloudflare(hiveIn: string, input: ConnectCloudflare, actorIn: string): Promise<VaultStatus> {
    const hive = this.bind(hiveIn);
    const parsed = ConnectCloudflareSchema.safeParse(input);
    if (!parsed.success) {
      // Paths only: zod messages never include the value, but stay explicit.
      throw new Error(`INVALID_INPUT: invalid ${[...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ")}`);
    }
    const actor = clip(String(actorIn ?? "unknown"), MAX_ACTOR);
    const creds = { accountId: parsed.data.accountId, apiToken: parsed.data.apiToken.trim() };

    const outcome = await verifyCloudflare(hive, creds, this.cloudflareFetch());
    const now = Date.now();
    if (!outcome.ok) {
      this.audit(hive, "connect_rejected", actor, "connect cloudflare", false, now);
      return { hive, secret: CLOUDFLARE_SECRET, connected: false, accountId: null, verifiedAt: null, checks: outcome.checks };
    }

    // No other call may interleave between reading the DEK row and writing the
    // ciphertext (crypto.subtle awaits would otherwise let one in).
    await this.exclusive(async () => {
      const ring = await this.keyring();
      const dek = await this.dekFor(hive, ring, now);
      const prev = this.secretRow(hive, CLOUDFLARE_SECRET);
      const version = (prev ? Number(prev.version) : 0) + 1;
      const sealed = await seal(dek, encodeJson(creds), aadFor(hive, CLOUDFLARE_SECRET, version));
      this.sql.exec(
        `INSERT INTO secrets (hive, name, version, iv, ct, account_id, verified_at, checks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hive, name) DO UPDATE SET version = excluded.version, iv = excluded.iv, ct = excluded.ct,
           account_id = excluded.account_id, verified_at = excluded.verified_at, checks = excluded.checks,
           updated_at = excluded.updated_at`,
        hive,
        CLOUDFLARE_SECRET,
        version,
        sealed.iv,
        sealed.ct,
        creds.accountId,
        now,
        JSON.stringify(outcome.checks),
        now,
        now,
      );
      this.audit(hive, "connect", actor, "connect cloudflare", true, now);
    });
    return this.status(hive);
  }

  status(hiveIn: string): VaultStatus {
    const hive = this.bind(hiveIn);
    const row = this.secretRow(hive, CLOUDFLARE_SECRET);
    if (!row) return { hive, secret: CLOUDFLARE_SECRET, connected: false, accountId: null, verifiedAt: null, checks: [] };
    return {
      hive,
      secret: CLOUDFLARE_SECRET,
      connected: true,
      accountId: row.account_id === null ? null : String(row.account_id),
      verifiedAt: row.verified_at === null ? null : Number(row.verified_at),
      checks: row.checks ? (JSON.parse(String(row.checks)) as CloudflareCheck[]) : [],
    };
  }

  // ── reader ────────────────────────────────────────────────────────────

  /**
   * Decrypt the hive's Cloudflare credential for one use. Audited (hive,
   * caller, purpose, time; never the value). Nothing is cached.
   */
  async revealCloudflare(hiveIn: string, callerIn: string, purposeIn?: string): Promise<CloudflareCredential> {
    const hive = this.bind(hiveIn);
    const caller = clip(String(callerIn), MAX_ACTOR);
    const purpose = clip(String(purposeIn ?? "unspecified"), MAX_PURPOSE);
    const now = Date.now();
    return this.exclusive(async () => {
      const row = this.secretRow(hive, CLOUDFLARE_SECRET);
      if (!row) {
        this.audit(hive, "reveal_denied", caller, purpose, false, now);
        throw new Error(`NOT_FOUND: hive ${hive} has no Cloudflare credential; connect one in the Genesis wizard`);
      }
      try {
        const ring = await this.keyring();
        const dek = await this.dekFor(hive, ring, now);
        const value = decodeJson<CloudflareCredential>(
          await open(dek, { iv: new Uint8Array(row.iv as ArrayBuffer), ct: new Uint8Array(row.ct as ArrayBuffer) }, aadFor(hive, CLOUDFLARE_SECRET, Number(row.version))),
        );
        this.sql.exec("UPDATE secrets SET last_used_at = ? WHERE hive = ? AND name = ?", now, hive, CLOUDFLARE_SECRET);
        this.audit(hive, "reveal", caller, purpose, true, now);
        return { accountId: value.accountId, apiToken: value.apiToken };
      } catch (e) {
        this.audit(hive, "reveal_denied", caller, purpose, false, now);
        throw e;
      }
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  private lock: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` with no other exclusive section interleaved (a per-object mutex).
   * Unlike blockConcurrencyWhile, a throw does not reset the object.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Validate the hive and pin this DO to it (one DO per hive). */
  private bind(hiveIn: string): string {
    const hive = assertHive(hiveIn);
    const other = this.sql.exec("SELECT hive FROM deks WHERE hive != ? LIMIT 1", hive).toArray()[0];
    if (other) throw new Error("CONFLICT: this vault belongs to another hive");
    return hive;
  }

  /** The hive's DEK: unwrapped (re-wrapped under the current KEK if needed), or created. */
  private async dekFor(hive: string, ring: Keyring, now: number): Promise<CryptoKey> {
    const row = this.sql.exec("SELECT wrapped_dek, kek_version FROM deks WHERE hive = ?", hive).toArray()[0];
    if (!row) {
      const { dek, wrapped } = await newWrappedDek(ring);
      this.sql.exec("INSERT INTO deks (hive, wrapped_dek, kek_version, created_at) VALUES (?, ?, ?, ?)", hive, wrapped.wrapped, wrapped.kekVersion, now);
      return dek;
    }
    const stored: WrappedDek = { wrapped: new Uint8Array(row.wrapped_dek as ArrayBuffer), kekVersion: String(row.kek_version) };
    const { dek, rewrapped } = await unwrapDek(ring, stored);
    if (rewrapped) {
      this.sql.exec(
        "UPDATE deks SET wrapped_dek = ?, kek_version = ?, rewrapped_at = ? WHERE hive = ?",
        rewrapped.wrapped,
        rewrapped.kekVersion,
        now,
        hive,
      );
    }
    return dek;
  }

  private secretRow(hive: string, name: string) {
    return this.sql.exec("SELECT * FROM secrets WHERE hive = ? AND name = ?", hive, name).toArray()[0] ?? null;
  }

  private audit(hive: string, action: string, actor: string, purpose: string, ok: boolean, at: number): void {
    this.sql.exec(
      "INSERT INTO audit (hive, secret, action, actor, purpose, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      hive,
      CLOUDFLARE_SECRET,
      action,
      actor,
      purpose,
      ok ? 1 : 0,
      at,
    );
  }
}
