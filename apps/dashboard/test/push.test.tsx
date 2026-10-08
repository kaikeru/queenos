/** T7: the "Push code" page, submission origin badges, and their pure helpers. */
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { GitToken, MergeTrain } from "@queenos/queen-types";

import { ApiError } from "../src/api";
import { itemOrigin, originBadge, pushedItemOrigin } from "../src/origin";
import { PushCode } from "../src/PushCode";
import { gitRemote, pushSteps, sortTokens, tokenApiUnavailable, tokenState } from "../src/pushLogic";
import { OriginChip } from "../src/shell";
import { itemIdOf } from "../src/swarm";

const NOW = 1_800_000_000_000;
const tok = (id: string, over: Partial<GitToken> = {}): GitToken => ({
  id, email: "a@kaikeru.com", scopes: ["read", "push"], label: null, createdAt: NOW - 1000, expiresAt: NOW + 86_400_000, lastUsedAt: null, revokedAt: null, ...over,
});

describe("push instructions", () => {
  test("the remote is the edge's /git/<hive> on the current origin", () => {
    expect(gitRemote("https://queenos.kaikeru.com", "demo")).toBe("https://queenos.kaikeru.com/git/demo");
    expect(gitRemote("http://localhost:5191/", "demo")).toBe("http://localhost:5191/git/demo");
  });

  test("steps: cached-credential clone, race branch names, push HEAD, verdict notes; never a token", () => {
    const all = pushSteps("https://q.example", "demo").map((s) => s.cmd).join("\n");
    expect(all).toContain("git -c credential.helper='cache --timeout=3600' clone https://q.example/git/demo demo");
    expect(all).toContain("item/<id>");
    expect(all).toContain("goal/<slug>");
    expect(all).toContain("git push origin HEAD");
    expect(all).toContain("git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict");
    expect(all).not.toContain("qgt_");
  });
});

describe("tokens", () => {
  test("state: revoked beats expired beats active", () => {
    expect(tokenState(tok("a"), NOW)).toBe("active");
    expect(tokenState(tok("b", { expiresAt: NOW }), NOW)).toBe("expired");
    expect(tokenState(tok("c", { revokedAt: NOW - 5, expiresAt: NOW - 1 }), NOW)).toBe("revoked");
  });

  test("active tokens first, newest first", () => {
    const list = [tok("old", { createdAt: 1 }), tok("rev", { createdAt: 9, revokedAt: 10 }), tok("new", { createdAt: 5 })];
    expect(sortTokens(list, NOW).map((t) => t.id)).toEqual(["new", "old", "rev"]);
  });

  test("an absent token API (sim without the edge, old edge) is not an auth error", () => {
    expect(tokenApiUnavailable(new ApiError("x", 0))).toBe(true);
    expect(tokenApiUnavailable(new ApiError("x", 404))).toBe(true);
    expect(tokenApiUnavailable(new ApiError("x", 502))).toBe(true);
    expect(tokenApiUnavailable(new ApiError("x", 401))).toBe(false);
    expect(tokenApiUnavailable(new Error("x"))).toBe(false);
  });

  test("the page renders instructions for the hive and the token panel", () => {
    const html = renderToString(<PushCode hive="demo" origin="https://queenos.kaikeru.com" />);
    expect(html).toContain("PUSH CODE");
    expect(html).toContain("https://queenos.kaikeru.com/git/demo");
    expect(html).toContain("GIT TOKENS");
    expect(html).toContain("Mint token");
    expect(html).not.toContain("qgt_");
  });
});

describe("origin badges", () => {
  const train = (id: string, origin: MergeTrain["origin"], createdAt = NOW): MergeTrain =>
    ({ trainId: id, baseSha: "0", includedPrompts: ["item-1"], artifactRepo: "r", status: "BUILDING", createdAt, lane: "BUILD", origin }) as MergeTrain;

  test("drone (absent / null), human:<email>, agent:<name> with the owner in the tooltip", () => {
    expect(originBadge(undefined).text).toBe("drone");
    expect(originBadge(null).kind).toBe("drone");
    expect(originBadge({ kind: "human", id: "kyle@kaikeru.com" })).toMatchObject({ kind: "human", text: "human:kyle@kaikeru.com" });
    const a = originBadge({ kind: "agent", id: "claude-code@kyle@kaikeru.com" });
    expect(a).toMatchObject({ kind: "agent", text: "agent:claude-code" });
    expect(a.title).toContain("kyle@kaikeru.com");
  });

  test("an item takes its newest pushed train's origin, else its inbox handle, else drone", () => {
    const human = train("t1", { kind: "human", id: "a@kaikeru.com" }, NOW - 10);
    const agent = train("t2", { kind: "agent", id: "bot@a@kaikeru.com" }, NOW);
    expect(itemOrigin(null, [train("t0", undefined), human, agent]).text).toBe("agent:bot");
    expect(itemOrigin(null, [train("t0", null)]).text).toBe("drone");
    const inbox = { repo: "demo-in-kyle", ref: "refs/heads/feat/x", handle: "kyle", headSha: "a".repeat(40), handoff: false };
    expect(itemOrigin({ inbox }, []).text).toBe("push:kyle");
  });

  test("status rows badge pushed items only", () => {
    const human = train("t1", { kind: "human", id: "a@kaikeru.com" });
    const state = { trains: { t1: human, t0: { ...train("t0", undefined), includedPrompts: ["item-2"] } }, trainOrder: ["t0", "t1"] };
    expect(pushedItemOrigin(state, { itemId: itemIdOf(human)!, inbox: null }, itemIdOf)?.text).toBe("human:a@kaikeru.com");
    expect(pushedItemOrigin(state, { itemId: "item-2", inbox: null }, itemIdOf)).toBeNull();
  });

  test("the chip renders the label with a tooltip and nothing for null", () => {
    const html = renderToString(<OriginChip badge={originBadge({ kind: "human", id: "a@kaikeru.com" })} />);
    expect(html).toContain("origin--human");
    expect(html).toContain("human:a@kaikeru.com");
    expect(renderToString(<OriginChip badge={null} />)).toBe("");
  });
});
