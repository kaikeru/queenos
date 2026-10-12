import type { ForkDeps } from "@queenos/hive-kit/artifacts";
import type { McpArtifacts } from "./ports";

/**
 * forkRepo's deps for queenos-mcp. The readiness probe mints a 10-minute write token for the fresh fork, asks
 * receive-pack's advertisement with it, and revokes it at once. The token never leaves this function.
 */
export function forkDepsFor(artifacts: McpArtifacts, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void>, now: () => number): ForkDeps {
  return {
    artifacts,
    sleep,
    now,
    probeStatus: async (repo) => {
      try {
        using h = await artifacts.get(repo);
        const [{ remote }, tok] = await Promise.all([h.info(), h.createToken("write", 600)]);
        try {
          const res = await fetchFn(`${remote.replace(/\/+$/, "")}/info/refs?service=git-receive-pack`, { headers: { authorization: `Bearer ${tok.plaintext}` } });
          await res.body?.cancel().catch(() => undefined);
          return { status: res.status, ray: res.headers.get("cf-ray") };
        } finally {
          await h.revokeToken(tok.id).catch(() => false);
        }
      } catch {
        return null; // inconclusive: counts as pushable
      }
    },
  };
}
