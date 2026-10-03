import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_API_ORIGIN } from "@queenos/hive-kit";
import { cloudflareFetchFor } from "../src/dev-fetch";

afterEach(() => vi.restoreAllMocks());

describe("cloudflareFetchFor (dev-only fake Cloudflare seam)", () => {
  it("rewrites the Cloudflare API origin to the dev base", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await cloudflareFetchFor("http://127.0.0.1:9999/")(`${CLOUDFLARE_API_ORIGIN}/accounts/x/tokens/verify`, { method: "GET" });
    expect(spy.mock.calls[0]![0]).toBe("http://127.0.0.1:9999/accounts/x/tokens/verify");
  });
  it("is a plain fetch when unset", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await cloudflareFetchFor(undefined)(`${CLOUDFLARE_API_ORIGIN}/user/tokens/verify`, {});
    expect(spy.mock.calls[0]![0]).toBe(`${CLOUDFLARE_API_ORIGIN}/user/tokens/verify`);
  });
});
