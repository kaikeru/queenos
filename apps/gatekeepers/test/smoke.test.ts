import { describe, expect, it } from "vitest";
import { FetchSmokeProbe, SMOKE_CHECK, type SmokeFetch } from "../src/smoke";
import { firstErrorLine } from "../src/scribe";
import { readConfig } from "../src/config";

function probe(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetch: SmokeFetch = async (url, init) => {
    calls.push({ url, init });
    const r = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (r instanceof Error) throw r;
    return r.clone();
  };
  return { p: new FetchSmokeProbe({ fetch, attempts: 3, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) }), calls, sleeps };
}

describe("FetchSmokeProbe", () => {
  it("passes on 2xx and requests <previewUrl>/ exactly once", async () => {
    const { p, calls, sleeps } = probe(new Response('{"ok":true}', { status: 200 }));
    const r = await p.check("https://t-abc-app.sub.workers.dev");
    expect(r).toMatchObject({ passed: true, status: 200 });
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([["https://t-abc-app.sub.workers.dev/", "GET"]]);
    expect(sleeps).toEqual([]);
  });

  it("does not double the slash on a trailing-slash URL", async () => {
    const { p, calls } = probe(new Response("ok"));
    await p.check("https://x.dev/");
    expect(calls[0]!.url).toBe("https://x.dev/");
  });

  it("fails on a persistent 500, with the status and a body snippet in the raw log (Scribe input)", async () => {
    const body = '{"ok":false,"error":"Cannot read properties of undefined (reading \'enabled\')"}';
    const { p, calls, sleeps } = probe(new Response(body, { status: 500 }));
    const r = await p.check("https://x.dev");
    expect(r.passed).toBe(false);
    expect(r.status).toBe(500);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([10, 10]);
    expect(r.log).toContain("smoke attempt 3/3: HTTP 500");
    expect(r.log).toContain("response body: " + body);
    expect(r.log).toContain(`FAIL  ${SMOKE_CHECK}`);
    expect(r.firstError).toBe("AssertionError: preview smoke failed: GET / returned HTTP 500 (expected 2xx)");
    expect(firstErrorLine(r.log)).toBe(r.firstError);
  });

  it("retries a not-yet-ready preview (404 then 200) and a network error", async () => {
    const a = probe(new Response("nope", { status: 404 }), new Response("ok", { status: 200 }));
    expect((await a.p.check("https://x.dev")).passed).toBe(true);
    expect(a.calls).toHaveLength(2);

    const b = probe(new TypeError("fetch failed"), new Response("ok"));
    const rb = await b.p.check("https://x.dev");
    expect(rb.passed).toBe(true);
    expect(rb.log).toContain("network failure: fetch failed");
  });

  it("fails after retries on a network error", async () => {
    const { p, calls } = probe(new TypeError("fetch failed"));
    const r = await p.check("https://x.dev");
    expect(calls).toHaveLength(3);
    expect(r).toMatchObject({ passed: false });
    expect(r.status).toBeUndefined();
    expect(r.firstError).toMatch(/unreachable after 3 attempts \(fetch failed\)/);
  });

  it("feature kind: 400/401/405/422 pass (the app answered deliberately)", async () => {
    for (const code of [400, 401, 405, 422, 302]) {
      const { p, calls } = probe(new Response("bad input", { status: code }));
      const r = await p.check("https://x.dev", "/features/hex", "feature");
      expect(r).toMatchObject({ passed: true, status: code });
      expect(calls).toHaveLength(1);
    }
  });

  it("feature kind: 404 and 500 fail with the route in the error", async () => {
    for (const code of [404, 500, 503]) {
      const { p } = probe(new Response("x", { status: code }));
      const r = await p.check("https://x.dev", "/features/hex", "feature");
      expect(r.passed).toBe(false);
      expect(r.status).toBe(code);
      expect(r.firstError).toContain(`GET /features/hex returned HTTP ${code}`);
      expect(r.log).toContain("FAIL  preview smoke > GET /features/hex is routed");
    }
  });

  it("feature kind: a network failure fails", async () => {
    const { p } = probe(new TypeError("fetch failed"));
    expect((await p.check("https://x.dev", "/f", "feature")).passed).toBe(false);
  });

  it("base kind: /health 400 fails (default kind is base)", async () => {
    const { p } = probe(new Response("bad", { status: 400 }));
    const r = await p.check("https://x.dev", "/health");
    expect(r.passed).toBe(false);
    expect(r.firstError).toContain("expected 2xx");
  });

  it("aborts a hung request at the timeout", async () => {
    const fetch: SmokeFetch = (_url, init) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))));
    const p = new FetchSmokeProbe({ fetch, attempts: 1, timeoutMs: 20 });
    const r = await p.check("https://x.dev");
    expect(r.passed).toBe(false);
    expect(r.log).toContain("timed out after 20ms");
  });
});

describe("phase-wait budget", () => {
  it("defaults to 24 x 5 s (2 minutes) to cover the preview deploy", () => {
    const c = readConfig({});
    expect(c.phaseRetries * c.phaseWaitMs).toBe(120_000);
  });
});
