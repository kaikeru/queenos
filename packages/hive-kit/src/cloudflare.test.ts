import { describe, expect, it } from "vitest";
import { CloudflareApiError, CloudflareClient, JS_MODULE_TYPE, type CloudflareFetch } from "./cloudflare.js";

interface Call {
  url: string;
  init: RequestInit;
}

function harness(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetch: CloudflareFetch = async (url, init) => {
    calls.push({ url, init });
    const r = queue.shift();
    if (!r) throw new Error("no more fake responses");
    if (r instanceof Error) throw r;
    return r;
  };
  const client = new CloudflareClient({ accountId: "acct1", token: "tok-secret", fetch });
  return { client, calls };
}

const ok = (result: unknown, status = 200) => new Response(JSON.stringify({ success: true, errors: [], result }), { status });
const fail = (status: number, code: number, message = "nope") =>
  new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });
const base = "https://api.cloudflare.com/client/v4/accounts/acct1";
const headers = (c: Call) => c.init.headers as Record<string, string>;

describe("CloudflareClient", () => {
  it("verifyToken uses the account-owned endpoint", async () => {
    const { client, calls } = harness(ok({ id: "t1", status: "active", expires_on: "2027-01-01T00:00:00Z" }));
    expect(await client.verifyToken()).toEqual({ id: "t1", status: "active", expiresOn: "2027-01-01T00:00:00Z" });
    expect(calls[0]!.url).toBe(`${base}/tokens/verify`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(headers(calls[0]!).Authorization).toBe("Bearer tok-secret");
  });

  it("ensureWorker: no-op when it exists, creates on 404 / 10007", async () => {
    const a = harness(ok({ id: "w", name: "hive-app" }));
    expect(await a.client.ensureWorker("hive-app")).toEqual({ created: false });
    expect(a.calls).toHaveLength(1);

    const b = harness(fail(404, 10007, "worker not found"), ok({ id: "w", name: "hive-app" }));
    expect(await b.client.ensureWorker("hive-app")).toEqual({ created: true });
    expect(b.calls[1]!.url).toBe(`${base}/workers/workers`);
    expect(b.calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(b.calls[1]!.init.body as string)).toEqual({ name: "hive-app", subdomain: { enabled: true, previews_enabled: true } });
  });

  it("ensureWorker: a 403 on the probe is surfaced, not swallowed", async () => {
    const { client } = harness(fail(403, 10000, "Authentication error"));
    await expect(client.ensureWorker("x")).rejects.toMatchObject({ status: 403, retryable: false });
  });

  it("getPreview returns null when missing (10025) and createPreview posts the name", async () => {
    const a = harness(fail(404, 10025));
    expect(await a.client.getPreview("w", "t-abc")).toBeNull();
    expect(a.calls[0]!.url).toBe(`${base}/workers/workers/w/previews/t-abc`);

    const b = harness(ok({ id: "pid", name: "t-abc", slug: "t-abc", urls: ["https://t-abc-w.sub.workers.dev"] }));
    expect(await b.client.createPreview("w", "t-abc")).toEqual({ id: "pid", name: "t-abc", slug: "t-abc", urls: ["https://t-abc-w.sub.workers.dev"] });
    expect(b.calls[0]!.url).toBe(`${base}/workers/workers/w/previews`);
    expect(JSON.parse(b.calls[0]!.init.body as string)).toEqual({ name: "t-abc" });
    expect(headers(b.calls[0]!)["Content-Type"]).toBe("application/json");
  });

  it("deployPreview sends multipart: metadata JSON + one `files` part per module", async () => {
    const { client, calls } = harness(ok({ id: "dep1", urls: ["https://dep1-w.sub.workers.dev"] }));
    const r = await client.deployPreview("w", "pid", {
      mainModule: "src/index.js",
      compatibilityDate: "2026-10-02",
      annotations: { "workers/commit_sha": "abc" },
      modules: [
        { name: "src/index.js", contentType: JS_MODULE_TYPE, content: "export default {}" },
        { name: "src/a.js", contentType: JS_MODULE_TYPE, content: "export const a = 1" },
      ],
    });
    expect(r).toEqual({ id: "dep1", urls: ["https://dep1-w.sub.workers.dev"] });
    expect(calls[0]!.url).toBe(`${base}/workers/workers/w/previews/pid/deployments`);
    expect(headers(calls[0]!)["Content-Type"]).toBeUndefined();
    const form = calls[0]!.init.body as FormData;
    expect(JSON.parse(form.get("metadata") as string)).toEqual({
      main_module: "src/index.js",
      compatibility_date: "2026-10-02",
      annotations: { "workers/commit_sha": "abc" },
    });
    const files = form.getAll("files") as File[];
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["src/index.js", JS_MODULE_TYPE],
      ["src/a.js", JS_MODULE_TYPE],
    ]);
    expect(await files[1]!.text()).toBe("export const a = 1");
  });

  it("deletePreview: true on success, false when missing", async () => {
    const a = harness(ok(null));
    expect(await a.client.deletePreview("w", "t-abc")).toBe(true);
    expect(a.calls[0]!.init.method).toBe("DELETE");
    const b = harness(fail(404, 10222));
    expect(await b.client.deletePreview("w", "t-abc")).toBe(false);
  });

  it("uploadVersion: one part per module named by module name, keep_bindings, bindings_inherit", async () => {
    const { client, calls } = harness(ok({ id: "v1" }));
    const r = await client.uploadVersion("app", {
      mainModule: "index.js",
      compatibilityDate: "2026-10-02",
      keepSecrets: true,
      modules: [{ name: "index.js", contentType: JS_MODULE_TYPE, content: "x" }],
    });
    expect(r).toEqual({ versionId: "v1" });
    expect(calls[0]!.url).toBe(`${base}/workers/scripts/app/versions?bindings_inherit=strict`);
    const form = calls[0]!.init.body as FormData;
    expect(JSON.parse(form.get("metadata") as string).keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect((form.get("index.js") as File).type).toBe(JS_MODULE_TYPE);
  });

  it("createDeployment: percentage strategy, validates the split", async () => {
    const { client, calls } = harness(ok({ id: "d1" }));
    await client.createDeployment("app", [
      { versionId: "new", percentage: 10 },
      { versionId: "old", percentage: 90 },
    ]);
    expect(calls[0]!.url).toBe(`${base}/workers/scripts/app/deployments`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      strategy: "percentage",
      versions: [
        { version_id: "new", percentage: 10 },
        { version_id: "old", percentage: 90 },
      ],
    });
    await expect(client.createDeployment("app", [{ versionId: "a", percentage: 50 }])).rejects.toBeInstanceOf(CloudflareApiError);
  });

  it("getWorkersSubdomain", async () => {
    const { client, calls } = harness(ok({ subdomain: "kyle" }));
    expect(await client.getWorkersSubdomain()).toBe("kyle");
    expect(calls[0]!.url).toBe(`${base}/workers/subdomain`);
  });

  it("classifies errors: 429/5xx/network retryable, other 4xx not; the token never leaks", async () => {
    const cases: [Response | Error, boolean, number][] = [
      [fail(429, 971), true, 429],
      [new Response("<html>bad gateway</html>", { status: 502 }), true, 502],
      [fail(400, 10021), false, 400],
      [fail(401, 10000), false, 401],
      [new Error("socket closed for Bearer tok-secret"), true, 0],
    ];
    for (const [resp, retryable, status] of cases) {
      const { client } = harness(resp);
      const err = (await client.verifyToken().catch((e: unknown) => e)) as CloudflareApiError;
      expect(err).toBeInstanceOf(CloudflareApiError);
      expect({ retryable: err.retryable, status: err.status }).toEqual({ retryable, status });
      expect(err.message).not.toContain("tok-secret");
    }
  });
});
