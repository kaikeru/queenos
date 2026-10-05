import { describe, expect, it } from "vitest";
import { makeProbe } from "../src/ports";

describe("makeProbe", () => {
  it("returns status and measured latency", async () => {
    let t = 0;
    const probe = makeProbe((async () => {
      t += 42;
      return new Response("x", { status: 201 });
    }) as typeof fetch, () => t);
    expect(await probe("https://x.test/", {})).toEqual({ status: 201, ms: 42 });
  });
  it("turns network errors into status null instead of throwing", async () => {
    const probe = makeProbe((async () => {
      throw new TypeError("boom");
    }) as typeof fetch);
    expect((await probe("https://x.test/", {})).status).toBeNull();
  });
  it("sends headers and a GET with a timeout signal", async () => {
    let seen: RequestInit | undefined;
    const probe = makeProbe((async (_u: string, init?: RequestInit) => {
      seen = init;
      return new Response(null, { status: 200 });
    }) as typeof fetch);
    await probe("https://x.test/", { "Cloudflare-Workers-Version-Overrides": 'a="b"' });
    expect(seen).toMatchObject({ method: "GET", headers: { "Cloudflare-Workers-Version-Overrides": 'a="b"' } });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});
