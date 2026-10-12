/** T7: the "Push code" page, submission origin badges, and their pure helpers. */
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { GitToken, MergeTrain } from "@queenos/queen-types";

import { ApiError } from "../src/api";
import { itemOrigin, originBadge, pushedItemOrigin } from "../src/origin";
import { PushCode } from "../src/PushCode";
import { agentTokenSteps, checkAgentInput, gitRemote, pushSteps, tokenAgentText, sortTokens, tokenApiUnavailable, tokenState } from "../src/pushLogic";
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
    expect(all).toContain("item/<id>/<agent>");
    expect(all).toContain("goal/<slug>");
    expect(all).toContain("git push origin HEAD");
    expect(all).toContain("git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict");
    expect(all).not.toContain("qgt_");
  });
});

describe("agent tokens", () => {
  test("both blank = a plain token; a name alone or with a model builds the agent body", () => {
    expect(checkAgentInput("", "  ")).toEqual({ agent: undefined, errors: {} });
    expect(checkAgentInput(" haiku ", "")).toEqual({ agent: { name: "haiku" }, errors: {} });
    expect(checkAgentInput("haiku", " claude-haiku-4-5 ")).toEqual({ agent: { name: "haiku", model: "claude-haiku-4-5" }, errors: {} });
    expect(checkAgentInput("a", "anthropic/claude-opus-5-5").agent).toEqual({ name: "a", model: "anthropic/claude-opus-5-5" });
  });

  test("a model without a name is invalid; bad handles and models carry inline errors", () => {
    const m = checkAgentInput("", "claude-opus-4-5");
    expect(m.agent).toBeNull();
    expect(m.errors.name).toBeTruthy();
    for (const bad of [".hidden", "a..b", "x.lock", "a b", "x".repeat(65)]) {
      const r = checkAgentInput(bad, "");
      expect(r.agent).toBeNull();
      expect(r.errors.name).toBeTruthy();
    }
    const bm = checkAgentInput("ok", "bad model!");
    expect(bm.agent).toBeNull();
    expect(bm.errors.model).toBeTruthy();
    expect(bm.errors.name).toBeUndefined();
  });

  test("token list text: agent:<name> · claims <model>, or just agent:<name>, null for plain tokens", () => {
    expect(tokenAgentText(tok("a"))).toBeNull();
    expect(tokenAgentText(tok("a", { agent: null }))).toBeNull();
    expect(tokenAgentText(tok("a", { agent: { name: "haiku", model: null } }))).toBe("agent:haiku");
    expect(tokenAgentText(tok("a", { agent: { name: "haiku", model: "claude-haiku-4-5" } }))).toBe("agent:haiku · claims claude-haiku-4-5");
  });

  test("agent instructions: push to item/<id> with no suffix; identity comes from the token", () => {
    const [push] = agentTokenSteps({ name: "haiku", model: "claude-haiku-4-5" });
    expect(push?.cmd).toContain("git push origin HEAD:item/<id>");
    expect(push?.cmd).not.toContain("<agent>");
    expect(push?.note).toContain("agent:haiku");
    expect(push?.note).toContain("claims claude-haiku-4-5, unverified");
    expect(push?.note).toContain("Identity comes from the token");
    expect(agentTokenSteps({ name: "haiku", model: null })[0]?.note).not.toContain("claims");
  });

  test("human-token instructions are unchanged", () => {
    expect(pushSteps("https://q.example", "demo")[1]?.cmd).toContain("item/<id>/<agent>");
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
    expect(a.claim).toBeNull();
    expect(a.title).not.toContain("claims");
  });

  test("an agent's claimed model rides on the badge (self-reported tooltip); human and drone have none", () => {
    const a = originBadge({ kind: "agent", id: "claude-code@kyle@kaikeru.com", model: "claude-opus-4-5" });
    expect(a.claim).toBe("claude-opus-4-5");
    expect(a.title).toContain("claims claude-opus-4-5 (self-reported)");
    expect(originBadge({ kind: "human", id: "kyle@kaikeru.com" }).claim).toBeNull();
    expect(originBadge({ kind: "drone", id: "wf-1" }).claim).toBeNull();
    expect(originBadge(null).claim).toBeNull();
    const inbox = { repo: "r", ref: "refs/heads/x", handle: "kyle", headSha: "a".repeat(40), handoff: false };
    expect(itemOrigin({ inbox }, []).claim).toBeNull();
  });

  test("the chip shows a muted claim next to an agent badge only", () => {
    const html = renderToString(<OriginChip badge={originBadge({ kind: "agent", id: "bot@a@kaikeru.com", model: "claude-opus-4-5" })} />);
    expect(html).toContain("agent:bot");
    expect(html).toContain("claims claude-opus-4-5");
    expect(renderToString(<OriginChip badge={originBadge({ kind: "agent", id: "bot@a@kaikeru.com" })} />)).not.toContain("claims");
  });

  test("an MCP attempt's candidate chip shows the attempt id next to 'claims <model>'", () => {
    const b = originBadge({ kind: "agent", id: "opus@kyle@kaikeru.com", model: "claude-opus-5-5" }, "att_0123456789ab");
    expect(b).toMatchObject({ kind: "agent", text: "agent:opus", claim: "claude-opus-5-5", attempt: "att_0123456789ab" });
    expect(b.title).toContain("attempt att_0123456789ab");
    const html = renderToString(<OriginChip badge={b} />);
    expect(html).toContain("claims claude-opus-5-5");
    expect(html).toContain("att_0123456789ab");
    expect(originBadge({ kind: "human", id: "kyle@kaikeru.com" }).attempt).toBeNull();
    expect(renderToString(<OriginChip badge={originBadge({ kind: "agent", id: "bot@a@kaikeru.com" })} />)).not.toContain("att_");
    const t = { trainId: "t9", origin: { kind: "agent" as const, id: "opus@kyle@kaikeru.com" }, createdAt: NOW, attemptId: "att_0123456789ab" };
    expect(itemOrigin(null, [t]).attempt).toBe("att_0123456789ab");
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
