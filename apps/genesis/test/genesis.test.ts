import { env, SELF } from "cloudflare:test";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CharterSchema, WizardStateSchema, type Charter, type WizardState } from "@queenos/queen-types";
import type { GenesisNode } from "../src/node";
import { FakeWorld, setWorld, train } from "./fakes";

afterEach(() => setWorld(null));

let n = 0;
const slug = () => `hive-${++n}-${Math.random().toString(36).slice(2, 6)}`;

async function call(method: string, path: string, body?: unknown, user: string | null = "kyle@kaikeru.com") {
  const res = await SELF.fetch(`https://genesis.internal${path}`, {
    method,
    headers: { ...(user ? { "x-queen-user": user } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & WizardState };
}

const stubFor = (hive: string) => env.GENESIS.get(env.GENESIS.idFromName(hive));

describe("hive slug reservations (M10)", () => {
  it.each(["demo-att-0123456789ab", "demo-base-0123456789ab", "my-app-att-abcdef012345", "demo-att-0123456789ab-r2"])("refuses %s: its pushes would be routed as an attempt / base fork", async (hive) => {
    const w = new FakeWorld();
    setWorld(w);
    const r = await call("POST", "/api/genesis", { hive, name: "Nope" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/-att-<12 hex>/);
    expect(w.registry.calls.filter((c) => c.startsWith("register"))).toHaveLength(0);
  });

  it("still accepts look-alikes that are not the reserved shape", async () => {
    for (const hive of ["demo-att-0123", "demo-attempt-0123456789ab", "demo-base-0123456789abc", "demo-att-0123456789ag"]) {
      setWorld(new FakeWorld());
      expect((await call("POST", "/api/genesis", { hive, name: "Ok" })).status, hive).toBe(200);
    }
  });
});

async function startHive(w = new FakeWorld()) {
  setWorld(w);
  const hive = slug();
  const r = await call("POST", "/api/genesis", { hive, name: "Todo Tracker" });
  expect(r.status).toBe(200);
  return { w, hive };
}

/** Run the interview to a confirmed charter. */
async function confirmed(w = new FakeWorld()) {
  const { hive } = await startHive(w);
  await call("POST", `/api/genesis/${hive}/messages`, { text: "A todo app where I can add and tick off tasks. Uses https://api.example.com/holidays" });
  const s2 = await call("POST", `/api/genesis/${hive}/messages`, { text: "Routes: /todos and /todos/:id. No packages, just api.example.com." });
  const put = await call("PUT", `/api/genesis/${hive}/charter`, { charter: s2.json.charterDraft });
  expect(put.status).toBe(200);
  return { w, hive, charter: CharterSchema.parse(put.json.charterDraft) };
}

async function launched(w = new FakeWorld()) {
  const c = await confirmed(w);
  w.vault.connected = true;
  const l = await call("POST", `/api/genesis/${c.hive}/launch`);
  expect(l.json.step).toBe("HIVE_CREATING");
  return { ...c, commandId: w.commands[0]!.commandId };
}

describe("auth + routing", () => {
  it("rejects requests without x-queen-user and keeps /health open", async () => {
    setWorld(new FakeWorld());
    expect((await call("POST", "/api/genesis", { hive: "abc-def", name: "x" }, null)).status).toBe(401);
    expect((await call("GET", "/api/genesis/abc-def", undefined, null)).status).toBe(401);
    expect((await SELF.fetch("https://genesis.internal/health")).status).toBe(200);
  });

  it("validates bodies and slugs, and 404s unknown hives", async () => {
    setWorld(new FakeWorld());
    expect((await call("POST", "/api/genesis", { hive: "Bad Slug", name: "x" })).status).toBe(400);
    expect((await call("GET", "/api/genesis/Bad_Slug")).status).toBe(400);
    expect((await call("GET", "/api/genesis/never-started")).status).toBe(404);
  });

  it("maps a registry conflict to 409", async () => {
    const w = new FakeWorld();
    w.registry.conflict = true;
    setWorld(w);
    expect((await call("POST", "/api/genesis", { hive: slug(), name: "x" })).status).toBe(409);
  });
});

describe("wizard happy path (scripted)", () => {
  it("DESCRIBE -> CHARTER_READY -> DEPLOY_CONNECTED -> HIVE_CREATING -> FIRST_FLIGHT -> ACTIVE", async () => {
    const w = new FakeWorld();
    const { hive } = await startHive(w);
    expect(w.registry.projects.get(hive)).toMatchObject({ status: "ONBOARDING", createdBy: "kyle@kaikeru.com" });

    const s0 = await call("GET", `/api/genesis/${hive}`);
    expect(WizardStateSchema.parse(s0.json)).toMatchObject({ step: "DESCRIBE", vault: { connected: false } });

    // Turn 1 already yields a valid charter.
    const t1 = await call("POST", `/api/genesis/${hive}/messages`, { text: "A todo app where I can add and tick off tasks" });
    expect(t1.json.messages).toHaveLength(2);
    expect(CharterSchema.safeParse(t1.json.charterDraft).success).toBe(true);
    expect(w.llm.requests).toHaveLength(0);

    const t2 = await call("POST", `/api/genesis/${hive}/messages`, { text: "Routes: /todos. No packages, may call api.example.com" });
    expect(t2.json.messages).toHaveLength(4);
    const draft = CharterSchema.parse(t2.json.charterDraft);
    expect(draft.policy.allowedHosts).toEqual(["api.example.com"]);
    expect(draft.firstPrompt).toContain("/todos");

    // Edit and confirm.
    const edited: Charter = { ...draft, name: "Todo Tracker 2" };
    const put = await call("PUT", `/api/genesis/${hive}/charter`, { charter: edited });
    expect(put.json.step).toBe("CHARTER_READY");
    expect(w.registry.projects.get(hive)).toMatchObject({ name: "Todo Tracker 2" });

    // Not connected yet.
    expect((await call("POST", `/api/genesis/${hive}/launch`)).status).toBe(409);
    expect((await call("GET", `/api/genesis/${hive}`)).json.step).toBe("CHARTER_READY");

    // Vault connects (browser -> edge -> vault); the next GET advances.
    w.vault.connected = true;
    const g = await call("GET", `/api/genesis/${hive}`);
    expect(g.json).toMatchObject({ step: "DEPLOY_CONNECTED", vault: { connected: true } });

    const l = await call("POST", `/api/genesis/${hive}/launch`);
    expect(l.json.step).toBe("HIVE_CREATING");
    expect(w.commands).toHaveLength(1);
    const cmd = w.commands[0]!;
    expect(cmd).toMatchObject({ op: "CREATE_HIVE", hive, template: "worker-starter" });
    expect(JSON.parse(cmd.charterJson)).toEqual(edited);
    expect(cmd.commandId).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    // Launch is idempotent while in flight.
    await call("POST", `/api/genesis/${hive}/launch`);
    expect(w.commands).toHaveLength(1);

    // Provisioner reports; first prompt goes to the Queen.
    const stub = stubFor(hive);
    expect(await stub.reportHiveCreated({ commandId: cmd.commandId, hive, ok: true, mainSha: "c".repeat(40) })).toEqual({ outcome: "applied" });
    expect(w.queen.prompts).toEqual([{ namespace: hive, promptText: edited.firstPrompt }]);
    expect((await call("GET", `/api/genesis/${hive}`)).json.step).toBe("FIRST_FLIGHT");

    // Polling: no preview yet, then a train with a URL.
    w.queen.trains = [train({ previewUrl: null })];
    await runDurableObjectAlarm(stub);
    expect((await call("GET", `/api/genesis/${hive}`)).json.step).toBe("FIRST_FLIGHT");
    w.queen.trains = [train({ previewUrl: "https://preview.example.dev" })];
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const done = await call("GET", `/api/genesis/${hive}`);
    expect(done.json).toMatchObject({ step: "ACTIVE", previewUrl: "https://preview.example.dev", lastError: null });
    expect(w.registry.projects.get(hive)).toMatchObject({ status: "ACTIVE", urls: { preview: "https://preview.example.dev" } });
    // No more alarms once ACTIVE.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("resumes: state survives and start is idempotent", async () => {
    const { w, hive } = await startHive();
    await call("POST", `/api/genesis/${hive}/messages`, { text: "A blog" });
    const again = await call("POST", "/api/genesis", { hive, name: "Todo Tracker" });
    expect(again.json.messages).toHaveLength(2);
    expect(w.registry.calls.filter((c) => c.startsWith("register"))).toHaveLength(1);
  });
});

describe("secret guard", () => {
  it("refuses token-like pastes: no model call, nothing stored", async () => {
    const w = new FakeWorld();
    w.config = { llmMode: "live" };
    const { hive } = await startHive(w);
    const token = "cfut_" + "Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDe4FgHi7JkL";
    for (const text of [`my cloudflare token is ${token}`, "CLOUDFLARE_API_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789", "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"]) {
      const r = await call("POST", `/api/genesis/${hive}/messages`, { text });
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.json)).not.toMatch(/abcdefghijklmnop|Ab3dEf6/);
      expect(r.json.messages.at(-1)!.content).toMatch(/Connect/);
    }
    expect(w.llm.requests).toHaveLength(0);
    const stored = await call("GET", `/api/genesis/${hive}`);
    expect(JSON.stringify(stored.json)).not.toContain(token);
    expect(stored.json.messages[0]!.content).toMatch(/withheld/);
  });

  it("rejects a charter that contains a secret", async () => {
    const { hive, charter } = await confirmed();
    const bad = { ...charter, description: "uses key sk-ant-api03-abcdefghijklmnopqrstuvwxyz" };
    expect((await call("PUT", `/api/genesis/${hive}/charter`, { charter: bad })).status).toBe(400);
  });
});

describe("live interview", () => {
  it("calls the model with a capped history, merges the JSON draft and keeps fixed fields", async () => {
    const w = new FakeWorld();
    w.config = { llmMode: "live", model: "@cf/zai-org/glm-5.3-flash" };
    w.llm.reply = "```json\n" + JSON.stringify({
      reply: "Which hosts may it call?",
      charter: { name: "Todos", description: "A todo app", stack: { target: "evil" }, hive: "other", policy: { allowedHosts: ["api.example.com"] } },
    }) + "\n```";
    const { hive } = await startHive(w);
    let last!: Awaited<ReturnType<typeof call>>;
    for (let i = 0; i < 9; i++) last = await call("POST", `/api/genesis/${hive}/messages`, { text: `message ${i}` });
    const req = w.llm.requests.at(-1)!;
    expect(req.model).toBe("@cf/zai-org/glm-5.3-flash");
    expect(req.messages.length).toBeLessThanOrEqual(12);
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "message 8" });
    expect(req.system).toMatch(/at most three short questions/);
    const draft = last.json.charterDraft as Record<string, unknown>;
    expect(draft).toMatchObject({ name: "Todos", hive, stack: { target: "cloudflare-workers" }, policy: { allowedHosts: ["api.example.com"], allowedDeps: [] } });
    expect(last.json.messages.at(-1)!.content).toBe("Which hosts may it call?");
  });

  it("surfaces a model failure as 502 without storing a half turn", async () => {
    const w = new FakeWorld();
    w.config = { llmMode: "live" };
    w.llm.fail = true;
    const { hive } = await startHive(w);
    expect((await call("POST", `/api/genesis/${hive}/messages`, { text: "hi" })).status).toBe(502);
    expect((await call("GET", `/api/genesis/${hive}`)).json.messages).toHaveLength(0);
  });
});

describe("charter validation", () => {
  it("rejects invalid, mismatched and out-of-order charters", async () => {
    const { w, hive, charter } = await confirmed();
    expect((await call("PUT", `/api/genesis/${hive}/charter`, { charter: { ...charter, firstPrompt: "" } })).status).toBe(400);
    expect((await call("PUT", `/api/genesis/${hive}/charter`, { charter: { ...charter, stack: { ...charter.stack, template: "next" } } })).status).toBe(400);
    const wrong = await call("PUT", `/api/genesis/${hive}/charter`, { charter: { ...charter, hive: "someone-else" } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.message).toMatch(/charter.hive/);
    expect((await call("PUT", `/api/genesis/${hive}/charter`, {})).status).toBe(400);
    // Messages are closed after the charter is confirmed.
    expect((await call("POST", `/api/genesis/${hive}/messages`, { text: "more" })).status).toBe(409);
    expect(w.registry.projects.get(hive)?.status).toBe("ONBOARDING");
  });
});

describe("launch gating", () => {
  it("rejects launch before the charter, and before Cloudflare is connected", async () => {
    const { hive } = await startHive();
    expect((await call("POST", `/api/genesis/${hive}/launch`)).status).toBe(409);
    const c = await confirmed();
    const r = await call("POST", `/api/genesis/${c.hive}/launch`);
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(/connect cloudflare/i);
    expect(c.w.commands).toHaveLength(0);
  });

  it("keeps the cached Vault status when the Vault is down", async () => {
    const w = new FakeWorld();
    const { hive } = await confirmed(w);
    w.vault.connected = true;
    expect((await call("GET", `/api/genesis/${hive}`)).json.step).toBe("DEPLOY_CONNECTED");
    w.vault.failing = true;
    expect((await call("GET", `/api/genesis/${hive}`)).json).toMatchObject({ step: "DEPLOY_CONNECTED", vault: { connected: true } });
  });
});

describe("reportHiveCreated", () => {
  it("is idempotent per commandId and ignores stale ones", async () => {
    const w = new FakeWorld();
    const { hive, commandId } = await launched(w);
    const stub = stubFor(hive);
    const ok = { commandId, hive, ok: true, mainSha: "c".repeat(40) };
    expect(await stub.reportHiveCreated(ok)).toEqual({ outcome: "applied" });
    expect(await stub.reportHiveCreated(ok)).toEqual({ outcome: "duplicate" });
    expect(await stub.reportHiveCreated({ commandId: "old-command", hive, ok: false, summary: "boom" })).toEqual({ outcome: "ignored" });
    expect(w.queen.prompts).toHaveLength(1);
    expect((await call("GET", `/api/genesis/${hive}`)).json.step).toBe("FIRST_FLIGHT");
  });

  it("rejects malformed results and a wrong hive", async () => {
    const { hive, commandId } = await launched();
    const stub = stubFor(hive);
    // Call the instance directly: errors crossing the RPC boundary surface as unhandled rejections in the pool.
    const errorOf = (input: unknown) =>
      runInDurableObject(stub, async (node: GenesisNode) => {
        try {
          await node.reportHiveCreated(input as never);
          return "no error";
        } catch (e) {
          return (e as Error).message;
        }
      });
    expect(await errorOf({ commandId, hive: "other-hive", ok: true })).toMatch(/^INVALID_INPUT/);
    expect(await errorOf({ nope: 1 })).toMatch(/^INVALID_INPUT: invalid HiveCreatedResult/);
  });

  it("an ok:false report fails the wizard with the summary, and the registry says FAILED", async () => {
    const w = new FakeWorld();
    const { hive, commandId } = await launched(w);
    await stubFor(hive).reportHiveCreated({ commandId, hive, ok: false, summary: "Create hive failed: PERMISSION_DENIED" });
    const s = await call("GET", `/api/genesis/${hive}`);
    expect(s.json).toMatchObject({ step: "FAILED", lastError: "Create hive failed: PERMISSION_DENIED" });
    expect(w.registry.projects.get(hive)?.status).toBe("FAILED");
    expect(w.queen.prompts).toHaveLength(0);
  });

  it("fails (without making the Provisioner retry) when the Queen rejects the first prompt", async () => {
    const w = new FakeWorld();
    const { hive, commandId } = await launched(w);
    w.queen.promptError = new Error("INVALID_INPUT: nope");
    expect(await stubFor(hive).reportHiveCreated({ commandId, hive, ok: true })).toEqual({ outcome: "applied" });
    expect((await call("GET", `/api/genesis/${hive}`)).json).toMatchObject({ step: "FAILED" });
  });
});

describe("first flight", () => {
  it("only accepts a preview from the train that includes the first prompt", async () => {
    const w = new FakeWorld();
    const { hive, commandId } = await launched(w);
    const stub = stubFor(hive);
    await stub.reportHiveCreated({ commandId, hive, ok: true });
    w.queen.trains = [train({ trainId: "other", includedPrompts: ["p-99"], previewUrl: "https://other.dev" })];
    await runDurableObjectAlarm(stub);
    expect((await call("GET", `/api/genesis/${hive}`)).json.step).toBe("FIRST_FLIGHT");
    w.queen.snapshotError = new Error("queen restarting");
    await runDurableObjectAlarm(stub); // transient: keeps polling
    w.queen.snapshotError = null;
    w.queen.trains.push(train({ previewUrl: "https://mine.dev" }));
    await runDurableObjectAlarm(stub);
    expect((await call("GET", `/api/genesis/${hive}`)).json).toMatchObject({ step: "ACTIVE", previewUrl: "https://mine.dev" });
  });
});

describe("timeout and relaunch", () => {
  it("times out into FAILED, then a relaunch dispatches a new command and can complete", async () => {
    const w = new FakeWorld();
    const { hive, commandId } = await launched(w);
    const stub = stubFor(hive);

    // Still within budget: polling continues.
    w.clock += 9 * 60_000;
    await runDurableObjectAlarm(stub);
    expect((await call("GET", `/api/genesis/${hive}`)).json.step).toBe("HIVE_CREATING");

    w.clock += 2 * 60_000; // 11 minutes in
    await runDurableObjectAlarm(stub);
    const failed = await call("GET", `/api/genesis/${hive}`);
    expect(failed.json.step).toBe("FAILED");
    expect(failed.json.lastError).toMatch(/timed out after 10 minutes/);
    expect(w.registry.projects.get(hive)?.status).toBe("FAILED");
    // A late report for the timed-out command is ignored.
    expect(await stub.reportHiveCreated({ commandId, hive, ok: true })).toEqual({ outcome: "ignored" });

    const re = await call("POST", `/api/genesis/${hive}/launch`);
    expect(re.json).toMatchObject({ step: "HIVE_CREATING", lastError: null });
    expect(w.commands).toHaveLength(2);
    expect(w.commands[1]!.commandId).not.toBe(commandId);
    expect(w.commands[1]!.charterJson).toBe(w.commands[0]!.charterJson);
    expect(w.registry.projects.get(hive)?.status).toBe("ONBOARDING");

    expect(await stub.reportHiveCreated({ commandId: w.commands[1]!.commandId, hive, ok: true })).toEqual({ outcome: "applied" });
    w.queen.trains = [train({ previewUrl: "https://ok.dev" })];
    await runDurableObjectAlarm(stub);
    expect((await call("GET", `/api/genesis/${hive}`)).json).toMatchObject({ step: "ACTIVE", previewUrl: "https://ok.dev" });
  });

  it("times out waiting for the first preview", async () => {
    const w = new FakeWorld();
    const { hive, commandId } = await launched(w);
    const stub = stubFor(hive);
    await stub.reportHiveCreated({ commandId, hive, ok: true });
    w.clock += 11 * 60_000;
    await runDurableObjectAlarm(stub);
    expect((await call("GET", `/api/genesis/${hive}`)).json.lastError).toMatch(/waiting for the first preview/);
  });

  it("a failed dispatch lands in FAILED and can be relaunched", async () => {
    const w = new FakeWorld();
    const c = await confirmed(w);
    w.vault.connected = true;
    w.dispatchError = new Error("workflow unavailable");
    const l = await call("POST", `/api/genesis/${c.hive}/launch`);
    expect(l.json).toMatchObject({ step: "FAILED" });
    expect(l.json.lastError).toMatch(/workflow unavailable/);
    w.dispatchError = null;
    expect((await call("POST", `/api/genesis/${c.hive}/launch`)).json.step).toBe("HIVE_CREATING");
  });
});
