import { describe, expect, it } from "vitest";
import worker, { handleGit, trainRepoName } from "../src/index";
import { isTrainFork, TokenCache } from "../src/tokens";
import { advertisedRefs } from "../src/upload";
import { gitRequest, HIVE, MAIN_SHA, TRAIN_ID, TRAIN_REPO, World } from "./fakes";

describe("routing and identity", () => {
  it("requires the edge's x-queen-user", async () => {
    const w = new World();
    const res = await handleGit(gitRequest(`/git/${HIVE}/info/refs?service=git-upload-pack`, { user: null }), w.deps());
    expect(res.status).toBe(401);
    const bad = await handleGit(gitRequest(`/git/${HIVE}/info/refs?service=git-upload-pack`, { user: "not-an-email" }), w.deps());
    expect(bad.status).toBe(401);
    expect(w.tokens.size).toBe(0);
  });

  it("refuses malformed agent identity headers on reads too (fail closed)", async () => {
    const w = new World();
    const refs = `/git/${HIVE}/info/refs?service=git-upload-pack`;
    for (const opts of [{ agent: "bad!" }, { agent: ".x" }, { agent: "ok", model: "bad model" }, { model: "claude-opus-4-5" }]) {
      const res = await handleGit(gitRequest(refs, opts), w.deps());
      expect(res.status, JSON.stringify(opts)).toBe(401);
      expect(await res.text()).toMatch(/bad agent identity from the edge/);
    }
    expect(w.tokens.size).toBe(0);
    expect((await handleGit(gitRequest(refs, { agent: "claude-code", model: "claude-opus-4-5" }), w.deps())).status).toBe(200);
    expect((await handleGit(gitRequest(refs, { agent: "codex" }), w.deps())).status).toBe(200);
  });

  it("404s non-git paths and bad hive slugs; 403s dumb HTTP; 405s wrong methods", async () => {
    const w = new World();
    expect((await handleGit(gitRequest("/hives/demo"), w.deps())).status).toBe(404);
    expect((await handleGit(gitRequest("/git/X_Y/info/refs?service=git-upload-pack"), w.deps())).status).toBe(404);
    expect((await handleGit(gitRequest(`/git/${HIVE}/info/refs`), w.deps())).status).toBe(403);
    expect((await handleGit(gitRequest(`/git/${HIVE}/git-upload-pack`), w.deps())).status).toBe(405);
  });

  it("accepts the .git suffix", async () => {
    const w = new World();
    const res = await handleGit(gitRequest(`/git/${HIVE}.git/info/refs?service=git-upload-pack`), w.deps());
    expect(res.status).toBe(200);
  });

  it("404s an unknown hive", async () => {
    const w = new World();
    const res = await handleGit(gitRequest("/git/nohive/info/refs?service=git-upload-pack"), w.deps());
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/no hive nohive/);
  });

  it("the default export refuses to run without its bindings", async () => {
    const res = await worker.fetch(gitRequest(`/git/${HIVE}/info/refs?service=git-upload-pack`), {});
    expect(res.status).toBe(503);
  });
});

describe("read-only /t/<trainId> (§3.4)", () => {
  it("serves a train fork the Queen knows, filtered to main, with a read token", async () => {
    const w = new World();
    w.repos.set(TRAIN_REPO, { main: MAIN_SHA, commits: new Map() });
    w.gateTargets.set(TRAIN_REPO, { trainId: TRAIN_ID, lane: "BUILD", promptId: "p", promptText: "", previewUrl: null, phase: "TESTING", traceId: null, baseSha: null });
    const res = await handleGit(gitRequest(`/git/${HIVE}/t/${TRAIN_ID}/info/refs?service=git-upload-pack`), w.deps());
    expect(res.status).toBe(200);
    expect(advertisedRefs(new Uint8Array(await res.arrayBuffer()))).toEqual(["HEAD", "refs/heads/main"]);
    expect(w.calls.gateTarget).toEqual([TRAIN_REPO]);
    expect([...w.tokens.values()]).toEqual([{ repo: TRAIN_REPO, scope: "read" }]);
  });

  it("finds a -rN re-fork of the train", async () => {
    const w = new World();
    w.repos.set(`${TRAIN_REPO}-r2`, { main: MAIN_SHA, commits: new Map() });
    w.gateTargets.set(`${TRAIN_REPO}-r2`, { trainId: TRAIN_ID, lane: "BUILD", promptId: "p", promptText: "", previewUrl: null, phase: "TESTING", traceId: null, baseSha: null });
    const res = await handleGit(gitRequest(`/git/${HIVE}/t/${TRAIN_ID}/info/refs?service=git-upload-pack`), w.deps());
    expect(res.status).toBe(200);
  });

  it("404s a train the Queen does not know (never trusts the URL for a repo name), and refuses pushes", async () => {
    const w = new World();
    w.repos.set(TRAIN_REPO, { main: MAIN_SHA, commits: new Map() });
    const res = await handleGit(gitRequest(`/git/${HIVE}/t/${TRAIN_ID}/info/refs?service=git-upload-pack`), w.deps());
    expect(res.status).toBe(404);
    expect(w.tokens.size).toBe(0);
    const push = await handleGit(gitRequest(`/git/${HIVE}/t/${TRAIN_ID}/info/refs?service=git-receive-pack`), w.deps());
    expect(push.status).toBe(403);
    const post = await handleGit(gitRequest(`/git/${HIVE}/t/${TRAIN_ID}/git-receive-pack`, { method: "POST", body: "0000" }), w.deps());
    expect(post.status).toBe(403);
  });
});

describe("tokens (§8.2)", () => {
  it("names train forks like the Queen and only those may get write tokens", async () => {
    expect(trainRepoName(HIVE, TRAIN_ID)).toBe(TRAIN_REPO);
    expect(isTrainFork(HIVE, TRAIN_REPO)).toBe(true);
    expect(isTrainFork(HIVE, `${TRAIN_REPO}-r3`)).toBe(true);
    expect(isTrainFork(HIVE, HIVE)).toBe(false);
    expect(isTrainFork(HIVE, "other-train-7a90c3e11111")).toBe(false);
    const w = new World();
    const cache = new TokenCache(w.artifacts());
    await expect(cache.auth(HIVE, "write", HIVE)).rejects.toThrow(/refusing a write token/);
    expect(w.tokens.size).toBe(0);
  });

  it("caches per repo and scope, strips ?expires=, re-mints after expiry", async () => {
    const w = new World();
    let now = 0;
    const cache = new TokenCache(w.artifacts(), () => now);
    const a = await cache.auth(HIVE, "read", HIVE);
    expect(await cache.auth(HIVE, "read", HIVE)).toBe(a);
    expect(atob(a.authorization.slice(6))).not.toContain("expires");
    expect(w.tokens.size).toBe(1);
    now += 51 * 60_000;
    await cache.auth(HIVE, "read", HIVE);
    expect(w.tokens.size).toBe(2);
  });
});
