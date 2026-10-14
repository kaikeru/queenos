import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { VaultStatusSchema } from "@queenos/queen-types";
import * as entry from "../src/index";
import { VaultReader, VaultWriter } from "../src/index";
import { READER_CALLER } from "../src/vault-node";
import { TOKEN_TEMPLATE_URL } from "../src/token-template";
import { ACCOUNT, KEK_A, KEK_B, TOKEN, hooks, resetHooks } from "./fakes";

const writer = exports.VaultWriter as unknown as Pick<VaultWriter, "connectCloudflare" | "status" | "tokenTemplateUrl">;
const reader = exports.VaultReader as unknown as Pick<VaultReader, "getCloudflareCredential">;
const worker = exports.default;

const newHive = () => `hive-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (hive: string) => env.VAULT_NODE.get(env.VAULT_NODE.idFromName(hive));
const creds = { accountId: ACCOUNT, apiToken: TOKEN };

async function rpcError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
}

type Row = Record<string, SqlStorageValue>;

/** Every row of every table in the hive's VaultNode. */
function dump(hive: string): Promise<Record<string, Row[]>> {
  return runInDurableObject(stubFor(hive), (_, state) => {
    const sql = state.storage.sql;
    const out: Record<string, Row[]> = {};
    for (const t of ["deks", "secrets", "audit"]) out[t] = sql.exec(`SELECT * FROM ${t}`).toArray();
    return out;
  });
}

function assertNoToken(tables: Record<string, Row[]>): void {
  const needles = [TOKEN, TOKEN.slice(4, 24), btoa(TOKEN)];
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      for (const [col, v] of Object.entries(row)) {
        const text = v instanceof ArrayBuffer ? String.fromCharCode(...new Uint8Array(v)) : String(v);
        for (const n of needles) expect(text.includes(n), `${table}.${col} contains the token`).toBe(false);
      }
    }
  }
}

beforeEach(() => void resetHooks());

describe("vault worker", () => {
  it("serves /health and 404s everything else", async () => {
    expect((await worker.fetch("http://vault.test/health")).status).toBe(200);
    for (const path of ["/", "/vault/acme/cloudflare", "/api/vault/acme/status"]) {
      expect((await worker.fetch(`http://vault.test${path}`, { method: "POST", body: "{}" })).status).toBe(404);
    }
  });

  it("VaultWriter has no method that returns a secret; VaultReader has exactly one", () => {
    const methods = (c: { prototype: object }) => Object.getOwnPropertyNames(c.prototype).filter((n) => n !== "constructor").sort();
    expect(methods(VaultWriter)).toEqual(["connectCloudflare", "status", "tokenTemplateUrl"]);
    expect(methods(VaultReader)).toEqual(["getCloudflareCredential"]);
  });

  it("tokenTemplateUrl is the pre-filled account-token deep link", async () => {
    const { url } = await writer.tokenTemplateUrl();
    expect(url).toBe(TOKEN_TEMPLATE_URL);
    const u = new URL(url);
    expect(u.origin).toBe("https://dash.cloudflare.com");
    expect(u.searchParams.get("to")).toBe("/:account/api-tokens");
    expect(JSON.parse(u.searchParams.get("permissionGroupKeys")!)).toEqual([
      { key: "workers_scripts", type: "edit" },
      { key: "account_analytics", type: "read" },
    ]);
    expect(u.searchParams.get("name")).toBe("QueenOS Deploy");
  });
});

describe("connect + reveal", () => {
  it("verifies, stores only ciphertext, and hands the credential to the reader (audited)", async () => {
    const hive = newHive();
    expect(await writer.status(hive)).toMatchObject({ hive, connected: false, accountId: null, checks: [] });

    const status = await writer.connectCloudflare(hive, creds, "kyle@example.com");
    expect(VaultStatusSchema.parse(status)).toMatchObject({ hive, secret: "cloudflare", connected: true, accountId: ACCOUNT });
    expect(status.verifiedAt).toBeTypeOf("number");
    expect(status.checks.map((c) => [c.name, c.ok])).toEqual([
      ["token active", true],
      ["can upload Workers", true],
      ["workers.dev subdomain", true],
    ]);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(hooks.cloudflare.calls.some((c) => c.method === "POST" && c.body?.includes(`${hive}-app`))).toBe(true);
    expect(await writer.status(hive)).toEqual(status);

    expect(await reader.getCloudflareCredential(hive, "deploy cmd-1")).toEqual(creds);
    expect(await reader.getCloudflareCredential(hive)).toEqual(creds);

    const rows = await dump(hive);
    assertNoToken(rows);
    expect(rows.deks).toHaveLength(1);
    expect(rows.deks![0]!.kek_version).toMatch(/^k1-[0-9a-f]{16}$/);
    expect((rows.deks![0]!.wrapped_dek as ArrayBuffer).byteLength).toBe(40);
    expect(rows.secrets).toHaveLength(1);
    expect(rows.secrets![0]).toMatchObject({ hive, name: "cloudflare", version: 1, account_id: ACCOUNT });
    expect((rows.secrets![0]!.iv as ArrayBuffer).byteLength).toBe(12);
    expect(rows.audit!.map((a) => [a.action, a.actor, a.purpose, a.ok])).toEqual([
      ["connect", "kyle@example.com", "connect cloudflare", 1],
      ["reveal", READER_CALLER, "deploy cmd-1", 1],
      ["reveal", READER_CALLER, "unspecified", 1],
    ]);
    expect(rows.audit!.every((a) => typeof a.at === "number" && a.hive === hive)).toBe(true);
  });

  it("reconnecting bumps the version (new IV and AAD) and keeps the hive's DEK", async () => {
    const hive = newHive();
    await writer.connectCloudflare(hive, creds, "a@example.org");
    const before = await dump(hive);
    const second = { accountId: ACCOUNT, apiToken: `${TOKEN}-v2` };
    await writer.connectCloudflare(hive, second, "a@example.org");
    const after = await dump(hive);
    expect(after.secrets![0]).toMatchObject({ version: 2 });
    expect(after.deks![0]!.wrapped_dek).toEqual(before.deks![0]!.wrapped_dek);
    expect(await reader.getCloudflareCredential(hive, "p")).toEqual(second);
  });

  it("a failed verification stores nothing and returns connected:false with the checks", async () => {
    const hive = newHive();
    resetHooks({ write: 403, echoToken: true });
    const status = await writer.connectCloudflare(hive, creds, "a@example.org");
    expect(status).toMatchObject({ hive, connected: false, accountId: null, verifiedAt: null });
    expect(status.checks.map((c) => [c.name, c.ok])).toEqual([
      ["token active", true],
      ["can upload Workers", false],
    ]);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    const rows = await dump(hive);
    expect(rows.secrets).toEqual([]);
    expect(rows.deks).toEqual([]);
    expect(rows.audit!.map((a) => [a.action, a.ok])).toEqual([["connect_rejected", 0]]);
    expect((await writer.status(hive)).connected).toBe(false);
    expect(await rpcError(reader.getCloudflareCredential(hive, "deploy"))).toMatch(/^NOT_FOUND: /);
  });

  it("a failed reconnect leaves the previous credential in place", async () => {
    const hive = newHive();
    await writer.connectCloudflare(hive, creds, "a@example.org");
    resetHooks({ accountVerify: 401, userVerify: 401 });
    expect((await writer.connectCloudflare(hive, { accountId: ACCOUNT, apiToken: "x".repeat(40) }, "a@example.org")).connected).toBe(false);
    expect(await reader.getCloudflareCredential(hive)).toEqual(creds);
    expect((await writer.status(hive)).connected).toBe(true);
  });

  it("rejects bad input without echoing the token", async () => {
    const hive = newHive();
    const msg = await rpcError(writer.connectCloudflare(hive, { accountId: "not-hex", apiToken: TOKEN }, "a@example.org"));
    expect(msg).toMatch(/^INVALID_INPUT: invalid accountId/);
    expect(msg).not.toContain(TOKEN);
    expect(await rpcError(writer.connectCloudflare(hive, { accountId: ACCOUNT, apiToken: "short" }, "a"))).toMatch(/^INVALID_INPUT: invalid apiToken/);
    expect(await rpcError(writer.status("Bad Hive"))).toMatch(/^INVALID_INPUT: /);
    expect(await rpcError(reader.getCloudflareCredential("../x"))).toMatch(/^INVALID_INPUT: /);
    expect(hooks.cloudflare.calls).toEqual([]);
  });

  it("hives are isolated: one hive's reader call never sees another's credential", async () => {
    const [a, b] = [newHive(), newHive()];
    await writer.connectCloudflare(a, creds, "a@example.org");
    expect(await rpcError(reader.getCloudflareCredential(b))).toMatch(/^NOT_FOUND: /);
  });

  it("a tampered ciphertext row fails closed (and is audited)", async () => {
    const hive = newHive();
    await writer.connectCloudflare(hive, creds, "a@example.org");
    await runInDurableObject(stubFor(hive), (_, state) => {
      const sql = state.storage.sql;
      const ct = new Uint8Array(sql.exec("SELECT ct FROM secrets").one().ct as ArrayBuffer);
      ct[0]! ^= 0x01;
      sql.exec("UPDATE secrets SET ct = ?", ct);
    });
    expect(await rpcError(reader.getCloudflareCredential(hive, "deploy"))).toMatch(/^UNAVAILABLE: secret failed authentication/);
    // Moving the ciphertext to another version (AAD mismatch) also fails.
    await runInDurableObject(stubFor(hive), (_, state) => void state.storage.sql.exec("UPDATE secrets SET version = 7"));
    expect(await rpcError(reader.getCloudflareCredential(hive))).toMatch(/^UNAVAILABLE: /);
    const audit = (await dump(hive)).audit!;
    expect(audit.at(-1)).toMatchObject({ action: "reveal_denied", ok: 0 });
  });

  it("a different KEK cannot read the hive", async () => {
    const hive = newHive();
    await writer.connectCloudflare(hive, creds, "a@example.org");
    hooks.keys = { VAULT_KEK: KEK_B };
    expect(await rpcError(reader.getCloudflareCredential(hive))).toMatch(/^UNAVAILABLE: .*unknown KEK version/);
  });

  it("rotates the KEK lazily: VAULT_KEK_PREVIOUS unwraps, the DEK is re-wrapped under the new VAULT_KEK", async () => {
    const hive = newHive();
    await writer.connectCloudflare(hive, creds, "a@example.org"); // env.test VAULT_KEK = KEK_A
    const before = (await dump(hive)).deks![0]!;

    hooks.keys = { VAULT_KEK: KEK_B, VAULT_KEK_PREVIOUS: KEK_A };
    expect(await reader.getCloudflareCredential(hive)).toEqual(creds);
    const after = (await dump(hive)).deks![0]!;
    expect(after.kek_version).not.toBe(before.kek_version);
    expect(after.rewrapped_at).toBeTypeOf("number");

    hooks.keys = { VAULT_KEK: KEK_B }; // old KEK retired
    expect(await reader.getCloudflareCredential(hive)).toEqual(creds);
    hooks.keys = { VAULT_KEK: KEK_A };
    expect(await rpcError(reader.getCloudflareCredential(hive))).toMatch(/^UNAVAILABLE: /);
  });
});

describe("worker entry module", () => {
  it("exports only entrypoints (classes or a handler): workerd rejects any other export at startup", () => {
    for (const [name, v] of Object.entries(entry)) {
      expect(typeof v === "function" || (typeof v === "object" && v !== null && "fetch" in v), name).toBe(true);
    }
  });
});
