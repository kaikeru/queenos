import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorld, OTHER, OWNER, currentWorld, setWorld } from "./fakes";

const URL_ = "http://mcp.test/mcp";
const base = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };

async function rpc(body: unknown, headers: Record<string, string>) {
  const res = await exports.default.fetch(URL_, { method: "POST", headers: { ...base, ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // an SSE body
  }
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as { id?: number; result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] } });
  return { res, data, json, sid: res.headers.get("mcp-session-id") };
}

async function session(owner = OWNER): Promise<string> {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1" } } }, { "x-queen-user": owner });
  expect(init.res.status).toBe(200);
  expect(init.sid).toBeTruthy();
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "x-queen-user": owner, "mcp-session-id": init.sid! });
  return init.sid!;
}

describe("queenos-mcp Worker", () => {
  beforeEach(() => setWorld(new FakeWorld()));
  afterEach(() => setWorld(null));

  it("refuses a request without x-queen-user (403) and answers /health", async () => {
    expect((await exports.default.fetch(URL_, { method: "POST", headers: base, body: "{}" })).status).toBe(403);
    expect(await (await exports.default.fetch("http://mcp.test/health")).json()).toEqual({ ok: true, service: "mcp" });
  });

  it("initialize, tools/list (19 tools), whoami and init_agent over Streamable HTTP", async () => {
    const sid = await session();
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    expect(list.data.find((m) => m.id === 2)?.result?.tools).toHaveLength(19);
    const who = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "whoami", arguments: {} } }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    expect(JSON.parse(who.data.find((m) => m.id === 3)!.result!.content![0]!.text)).toEqual({ owner: OWNER, agent: null });
    const init = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "init_agent", arguments: { name: "opus", model: "claude-opus-5-5", role: "worker" } } }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    expect(JSON.parse(init.data.find((m) => m.id === 4)!.result!.content![0]!.text)).toMatchObject({ name: "opus", owner: OWNER });
    const again = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "init_agent", arguments: { name: "opus", model: "m", role: "worker" } } }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    const r5 = again.data.find((m) => m.id === 5)!.result!;
    expect(r5.isError).toBe(true);
    expect(JSON.parse(r5.content![0]!.text)).toMatchObject({ code: "ALREADY_INITIALIZED", retryable: false });
  });

  it("a session id replayed by another owner is refused with 403 JSON (POST and GET)", async () => {
    const sid = await session();
    const stolen = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "whoami", arguments: {} } }, { "x-queen-user": OTHER, "mcp-session-id": sid });
    expect(stolen.res.status).toBe(403);
    expect(stolen.data.find((m) => m.id === 9)).toBeUndefined();
    expect(stolen.json).toEqual({ error: "forbidden" });
    const get = await exports.default.fetch(URL_, { method: "GET", headers: { accept: "text/event-stream", "x-queen-user": OTHER, "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } });
    expect(get.status).toBe(403);
    expect(await get.json()).toEqual({ error: "forbidden" });
    // The rightful owner still works.
    const ok = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "whoami", arguments: {} } }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    expect(JSON.parse(ok.data.find((m) => m.id === 10)!.result!.content![0]!.text)).toMatchObject({ owner: OWNER });
  });

  it("WIRE: a schema failure reaches the agent as JSON INVALID_INPUT without input values; tools/list still advertises the fields", async () => {
    const sid = await session();
    const bad = await rpc({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "init_agent", arguments: { name: "opus", model: "m", role: "boss" } } }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    const r = bad.data.find((m) => m.id === 20)!.result!;
    expect(r.isError).toBe(true);
    const e = JSON.parse(r.content![0]!.text) as { code: string; message: string; retryable: boolean };
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.retryable).toBe(false);
    expect(e.message.length).toBeLessThanOrEqual(200);
    expect(e.message).not.toContain("boss");
    const list = await rpc({ jsonrpc: "2.0", id: 21, method: "tools/list" }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    const tool = (list.data.find((m) => m.id === 21)!.result!.tools as unknown as { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[]).find((t) => t.name === "init_agent")!;
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["model", "name", "role"]);
    expect([...(tool.inputSchema.required ?? [])].sort()).toEqual(["model", "name", "role"]);
  });

  it("a DELETE of someone else's session is refused (403) and the session survives; the owner's DELETE ends it; an unknown session is 404", async () => {
    const sid = await session();
    const del = (owner: string, id: string) => exports.default.fetch(URL_, { method: "DELETE", headers: { "x-queen-user": owner, "mcp-session-id": id, "mcp-protocol-version": "2025-06-18" } });
    const refused = await del(OTHER, sid);
    expect(refused.status).toBe(403);
    await refused.text();
    const ok = await rpc({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "whoami", arguments: {} } }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    expect(JSON.parse(ok.data.find((m) => m.id === 30)!.result!.content![0]!.text)).toMatchObject({ owner: OWNER });
    const gone = await del(OWNER, sid);
    expect(gone.status).toBe(204);
    await gone.text();
    const unknown = await del(OWNER, "0".repeat(32));
    expect(unknown.status).toBe(404);
    await unknown.text();
  });

  it("WIRE: a retryable tool error carries retryable true and retryAfterMs on the wire", async () => {
    const sid = await session();
    const call = async (id: number, name: string, args: unknown) => rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, { "x-queen-user": OWNER, "mcp-session-id": sid });
    await call(40, "init_agent", { name: "opus", model: "claude-opus-5-5", role: "worker" });
    const w = currentWorld();
    w.queen.errors.set("getSnapshot", new Error("UNAVAILABLE: restarting"));
    const out = await call(41, "list_items", { hive: "demo" });
    const r = out.data.find((m) => m.id === 41)!.result!;
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content![0]!.text)).toEqual({ code: "UNAVAILABLE", message: "the hive is temporarily unavailable; retry", retryable: true, retryAfterMs: 2000 });
  });
});
