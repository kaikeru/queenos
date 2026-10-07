import { describe, expect, it } from "vitest";
import { GitError, GitRepo, MemoryGitServer, NOTES_REF, QUEEN_MERGE_IDENTITY, artifactsAuth, assertRepoPath, endpointKind, withHttpEvidence, cloneRepo, initRepo, stripTokenExpiry } from "./git.js";
import { renderRegistry } from "./registry.js";

const T0 = 1_790_000_000; // fixed Unix seconds

async function seeded() {
  const repo = await initRepo();
  await repo.writeFiles([{ path: "README.md", content: "# hive\n" }]);
  const base = await repo.commitAll({ message: "init", timestamp: T0 });
  return { repo, base };
}

describe("git on MemFS", () => {
  it("init → commit → addNote → readNote round-trip", async () => {
    const { repo, base } = await seeded();
    await repo.writeFiles([
      { path: "features/a.md", content: "A\n" },
      { path: "src/a.ts", content: "export const a = 1;\n" },
    ]);
    const oid = await repo.commitAll({ message: "feat: a", timestamp: T0 + 10 });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    const head = await repo.head();
    expect(head?.oid).toBe(oid);
    expect(head?.parents).toEqual([base]);
    expect(head?.author.timestamp).toBe(T0 + 10);
    expect(await repo.listFiles()).toEqual(["README.md", "features/a.md", "src/a.ts"]);
    expect(await repo.readFiles(["src/a.ts", "nope.txt"])).toEqual({ "src/a.ts": "export const a = 1;\n" });

    const note = JSON.stringify({ hello: "ledger" });
    const notesOid = await repo.addNote({ oid, note, timestamp: T0 + 10 });
    expect(notesOid).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.resolveRef(NOTES_REF)).toBe(notesOid);
    expect(await repo.readNote(oid)).toBe(note);
    expect(await repo.readNote(base)).toBeNull();
    expect(await repo.listNotes()).toEqual([{ target: oid, note: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
  });

  it("fixed timestamps make commits deterministic (replay-safe SHAs)", async () => {
    const run = async () => {
      const { repo } = await seeded();
      await repo.writeFiles([{ path: "x.txt", content: "same" }]);
      const oid = await repo.commitAll({ message: "m", timestamp: T0 + 1 });
      const n = await repo.addNote({ oid, note: "n", timestamp: T0 + 1 });
      return [oid, n];
    };
    expect(await run()).toEqual(await run());
  });

  it("stages deletions and refuses empty commits", async () => {
    const { repo } = await seeded();
    await expect(repo.commitAll({ message: "noop", timestamp: T0 + 2 })).rejects.toMatchObject({ code: "NOTHING_TO_COMMIT" });
    await repo.writeFiles([{ path: "README.md", delete: true }]);
    await repo.commitAll({ message: "rm", timestamp: T0 + 3 });
    expect(await repo.listFiles()).toEqual([]);
    const empty = await repo.commitAll({ message: "empty", timestamp: T0 + 4, allowEmpty: true });
    expect(empty).toMatch(/^[0-9a-f]{40}$/);
  });

  it("push without a remote fails with NO_REMOTE", async () => {
    const { repo } = await seeded();
    await expect(repo.push({ ref: "main" })).rejects.toBeInstanceOf(GitError);
    await expect(repo.pushNotes()).rejects.toMatchObject({ code: "NO_REMOTE" });
  });

  it("writeRef/resolveRef/readCommit", async () => {
    const { repo, base } = await seeded();
    await repo.writeRef("refs/heads/queen-land", base);
    expect(await repo.resolveRef("queen-land")).toBe(base);
    expect(await repo.readCommit("0".repeat(40))).toBeNull();
    await expect(repo.resolveRef("refs/heads/nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unsafe paths", async () => {
    for (const p of ["/abs", "../up", "a/../b", ".git/config", "a\\b", "", "a//b"]) {
      expect(() => assertRepoPath(p), p).toThrow(GitError);
    }
    expect(assertRepoPath("./src/a.ts")).toBe("src/a.ts");
  });

  it("Artifacts auth strips ?expires= and uses username x", () => {
    expect(stripTokenExpiry("art_v1_abc?expires=1790000000")).toBe("art_v1_abc");
    expect(artifactsAuth("art_v1_abc?expires=1")()).toEqual({ username: "x", password: "art_v1_abc" });
  });
});

const REG = "src/features/index.js";
const EMPTY_REG = renderRegistry([]);

/** main with a registry and a theme file; returns the repo and the base SHA. */
async function hive() {
  const repo = await initRepo();
  await repo.writeFiles([
    { path: REG, content: EMPTY_REG },
    { path: "src/theme.js", content: "export const bg = 'white';\nexport const fg = 'black';\n" },
    { path: "README.md", content: "# hive\n" },
  ]);
  const base = await repo.commitAll({ message: "init", timestamp: T0 });
  return { repo, base };
}

/** A branch off `from` with one commit of `files`; returns its head and leaves HEAD on main. */
async function branch(repo: GitRepo, name: string, from: string, files: Record<string, string>, ts: number): Promise<string> {
  const git = (await import("isomorphic-git")).default;
  await git.branch({ fs: repo.fs, dir: repo.dir, ref: name, object: from, checkout: true, force: true });
  await repo.writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
  const oid = await repo.commitAll({ message: name, timestamp: ts });
  await git.checkout({ fs: repo.fs, dir: repo.dir, ref: "main", force: true });
  return oid;
}

const feature = (name: string) => ({ [`src/features/${name}`]: `export const slug = "${name}";\n`, [REG]: renderRegistry([name]) });

describe("GitRepo.merge", () => {
  it("merges several members: the first fast-forwards, the rest make merge commits", async () => {
    const { repo, base } = await hive();
    const heads = [];
    for (const [i, n] of ["a.js", "b.js", "c.js", "d.js"].entries()) heads.push(await branch(repo, `m${i}`, base, feature(n), T0 + 10 + i));
    const outs = [];
    for (const [i, h] of heads.entries()) outs.push(await repo.merge({ theirs: h, message: `merge m${i}`, timestamp: T0 + 100 }));
    expect(outs[0]).toMatchObject({ oid: heads[0], fastForward: true, mergeCommit: false, base });
    for (const o of outs.slice(1)) expect(o).toMatchObject({ fastForward: false, mergeCommit: true });
    const head = await repo.head();
    expect(head?.parents).toHaveLength(2);
    expect(head?.message).toBe("merge m3\n");
    expect(head?.author.name).toBe(QUEEN_MERGE_IDENTITY.name);
    // The registry is the union; the worktree follows main.
    expect((await repo.readFiles([REG]))[REG]).toBe(renderRegistry(["a.js", "b.js", "c.js", "d.js"]));
    expect(await repo.listFiles()).toEqual(expect.arrayContaining(["src/features/a.js", "src/features/d.js"]));
    expect(await repo.changedPaths(base, "main")).toEqual(["src/features/a.js", "src/features/b.js", "src/features/c.js", "src/features/d.js", REG]);
  });

  it("two features that both register do not conflict (union registry)", async () => {
    const { repo, base } = await hive();
    const a = await branch(repo, "a", base, feature("dark.js"), T0 + 1);
    const b = await branch(repo, "b", base, feature("clock.js"), T0 + 2);
    await repo.merge({ theirs: a, message: "a", timestamp: T0 + 5, fastForward: false });
    const out = await repo.merge({ theirs: b, message: "b", timestamp: T0 + 5 });
    expect("oid" in out).toBe(true);
    const reg = await repo.readFiles([REG]);
    expect(reg[REG]).toBe(renderRegistry(["clock.js", "dark.js"]));
  });

  it("a content conflict is reported with paths and moves nothing", async () => {
    const { repo, base } = await hive();
    const a = await branch(repo, "a", base, { "src/theme.js": "export const bg = 'black!';\nexport const fg = 'black';\n" }, T0 + 1);
    const b = await branch(repo, "b", base, { "src/theme.js": "export const bg = 'navy blue';\nexport const fg = 'black';\n" }, T0 + 2);
    const first = await repo.merge({ theirs: a, message: "a", timestamp: T0 + 5 });
    expect(first).toMatchObject({ fastForward: true });
    const out = await repo.merge({ theirs: b, message: "b", timestamp: T0 + 5 });
    expect(out).toEqual({ conflict: { kind: "content", reason: "conflict", paths: ["src/theme.js"], ours: a, theirs: b, bases: [base] } });
    expect(await repo.resolveRef("main")).toBe(a);
    expect((await repo.readFiles(["src/theme.js"]))["src/theme.js"]).toContain("'black!'");
    await expect(repo.resolveRef("refs/queen/merge-theirs")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("add/add of one path with different content is unsupported, with the path", async () => {
    const { repo, base } = await hive();
    const a = await branch(repo, "a", base, { "src/new.js": "one\n" }, T0 + 1);
    const b = await branch(repo, "b", base, { "src/new.js": "two\n" }, T0 + 2);
    await repo.merge({ theirs: a, message: "a", timestamp: T0 + 5 });
    const out = await repo.merge({ theirs: b, message: "b", timestamp: T0 + 5 });
    expect(out).toMatchObject({ conflict: { kind: "unsupported", reason: "add-add", paths: ["src/new.js"] } });
  });

  it("a file/directory clash (MergeNotSupportedError) is unsupported with the overlapping paths", async () => {
    const { repo, base } = await hive();
    const a = await branch(repo, "a", base, { "src/x": "file\n" }, T0 + 1);
    const b = await branch(repo, "b", base, { "src/x/y.js": "dir\n" }, T0 + 2);
    await repo.merge({ theirs: a, message: "a", timestamp: T0 + 5 });
    const out = await repo.merge({ theirs: b, message: "b", timestamp: T0 + 5 });
    expect(out).toMatchObject({ conflict: { kind: "unsupported", reason: "not-supported" } });
  });

  it("already merged and criss-cross", async () => {
    const { repo, base } = await hive();
    const a = await branch(repo, "a", base, { "a.txt": "a\n" }, T0 + 1);
    await repo.merge({ theirs: a, message: "a", timestamp: T0 + 5 });
    expect(await repo.merge({ theirs: a, message: "again", timestamp: T0 + 6 })).toMatchObject({ oid: a, alreadyMerged: true });
    // Criss-cross: x and y each merge the other's parent.
    const x1 = await branch(repo, "x", base, { "x.txt": "x\n" }, T0 + 10);
    const y1 = await branch(repo, "y", base, { "y.txt": "y\n" }, T0 + 11);
    await repo.merge({ ours: "x", theirs: y1, message: "x+y", timestamp: T0 + 12, fastForward: false });
    await repo.merge({ ours: "y", theirs: x1, message: "y+x", timestamp: T0 + 12, fastForward: false });
    const out = await repo.merge({ ours: "x", theirs: "y", message: "cc", timestamp: T0 + 13 });
    expect(out).toMatchObject({ conflict: { kind: "unsupported", reason: "criss-cross" } });
  });

  it("a replay with the same timestamp makes identical SHAs", async () => {
    const run = async () => {
      const { repo, base } = await hive();
      const a = await branch(repo, "a", base, feature("a.js"), T0 + 1);
      const b = await branch(repo, "b", base, feature("b.js"), T0 + 2);
      await repo.merge({ theirs: a, message: "a", timestamp: T0 + 9 });
      const out = await repo.merge({ theirs: b, message: "b", timestamp: T0 + 9 });
      return "oid" in out ? out.oid : null;
    };
    const first = await run();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(await run()).toBe(first);
  });
});

describe("MemoryGitServer + shallow history", () => {
  const URL_MAIN = "https://mem.test/git/hive.git";
  const URL_FORK = "https://mem.test/git/fork.git";

  it("clone, push (CAS), and fetch over in-memory smart HTTP", async () => {
    const server = new MemoryGitServer();
    const origin = await server.create(URL_MAIN);
    await origin.writeFiles([{ path: "a.txt", content: "a\n" }]);
    const c1 = await origin.commitAll({ message: "c1", timestamp: T0 });
    const clone = await cloneRepo({ remote: URL_MAIN, http: server.http, ref: "main" });
    expect((await clone.head())?.oid).toBe(c1);
    await clone.writeFiles([{ path: "b.txt", content: "b\n" }]);
    const c2 = await clone.commitAll({ message: "c2", timestamp: T0 + 1 });
    await clone.push({ ref: "main" });
    expect(await origin.resolveRef("main")).toBe(c2);
    // Someone else moves main: our stale push is a NOT_FAST_FORWARD.
    await origin.writeFiles([{ path: "c.txt", content: "c\n" }]);
    await origin.commitAll({ message: "c3", timestamp: T0 + 2 });
    await clone.writeFiles([{ path: "d.txt", content: "d\n" }]);
    await clone.commitAll({ message: "c4", timestamp: T0 + 3 });
    await expect(clone.push({ ref: "main" })).rejects.toMatchObject({ code: "NOT_FAST_FORWARD" });
    server.deny = (_u, ref) => (ref.startsWith("refs/notes/") ? "denied" : undefined);
    await clone.addNote({ oid: c2, note: "n", timestamp: T0 });
    await expect(clone.pushNotes()).rejects.toMatchObject({ code: "PUSH_REJECTED" });
    // A server-side compare-and-swap miss ("fetch first") is NOT_FAST_FORWARD too.
    server.deny = (_u, ref) => (ref === "refs/heads/main" ? "fetch first" : undefined);
    await expect(clone.push({ ref: "main", force: true })).rejects.toMatchObject({ code: "NOT_FAST_FORWARD" });
  });

  it("a shallow base has no merge base until deepen; then it merges", async () => {
    const server = new MemoryGitServer();
    const origin = await server.create(URL_MAIN);
    await origin.writeFiles([{ path: REG, content: EMPTY_REG }]);
    await origin.commitAll({ message: "c1", timestamp: T0 });
    await origin.writeFiles([{ path: "one.txt", content: "1\n" }]);
    const c2 = await origin.commitAll({ message: "c2", timestamp: T0 + 1 });
    // The member forks at c2 and adds a feature; main moves on twice.
    await server.create(URL_FORK);
    const forkClone = await cloneRepo({ remote: URL_MAIN, http: server.http, ref: "main", depth: 0 });
    await forkClone.writeFiles(Object.entries(feature("f.js")).map(([path, content]) => ({ path, content })));
    const m1 = await forkClone.commitAll({ message: "member", timestamp: T0 + 3 });
    await forkClone.push({ ref: "main", remote: { url: URL_FORK } });
    for (const n of [3, 4]) {
      await origin.writeFiles([{ path: `${n}.txt`, content: `${n}\n` }]);
      await origin.commitAll({ message: `c${n}`, timestamp: T0 + n });
    }

    const car = await cloneRepo({ remote: URL_MAIN, http: server.http, ref: "main", depth: 1 });
    expect(await car.shallowCommits()).toHaveLength(1);
    expect(await car.fetchRef({ remoteRef: "refs/heads/main", localRef: "refs/queen/m/t1", remote: { url: URL_FORK }, depth: 1 })).toBe(m1);
    expect(await car.findMergeBase(["main", m1])).toEqual([]);
    expect(await car.merge({ theirs: m1, message: "m", timestamp: T0 + 9 })).toMatchObject({ conflict: { reason: "no-merge-base" } });

    await car.deepen();
    await car.deepen({ remote: { url: URL_FORK }, localRef: "refs/queen/m/t1" });
    expect(await car.shallowCommits()).toEqual([]);
    expect(await car.findMergeBase(["main", m1])).toEqual([c2]);
    const out = await car.merge({ theirs: m1, message: "m", timestamp: T0 + 9 });
    expect(out).toMatchObject({ mergeCommit: true, base: c2 });
    expect((await car.readFiles([REG]))[REG]).toBe(renderRegistry(["f.js"]));
    await car.push({ ref: "main" });
    expect(await origin.resolveRef("main")).toBe("oid" in out ? out.oid : "");
  });
});

describe("withHttpEvidence", () => {
  const urlBase = "https://acct.artifacts.cloudflare.net/git/ns/repo.git";
  const fake = (status: number, body: string, headers: Record<string, string> = {}) =>
    ({
      request: async () => ({
        url: urlBase,
        method: "POST",
        statusCode: status,
        statusMessage: status === 503 ? "Service Unavailable" : "OK",
        headers,
        body: (async function* () {
          yield new TextEncoder().encode(body);
        })(),
      }),
    }) as never;
  const read = async (b: AsyncIterable<Uint8Array>) => {
    let s = "";
    for await (const c of b) s += new TextDecoder().decode(c);
    return s;
  };

  it("adds endpoint, status, cf-ray, retry-after and a body snippet to a 503, and replays the body", async () => {
    const http = withHttpEvidence(fake(503, "upstream\nconnect error art_v2_secret123", { "cf-ray": "abc-LHR", "retry-after": "30" }));
    const res = await http.request({ url: `${urlBase}/git-upload-pack`, method: "POST", headers: { authorization: "Basic SECRET" } });
    expect(res.statusCode).toBe(503);
    expect(res.statusMessage).toBe(
      'Service Unavailable [HTTP 503 upload-pack cf-ray=abc-LHR retry-after=30 body="upstream connect error [redacted]"]',
    );
    expect(res.statusMessage).not.toMatch(/SECRET|secret123/);
    expect(await read(res.body as never)).toContain("upstream");
  });

  it("clips the body to 200 bytes", async () => {
    const http = withHttpEvidence(fake(503, "x".repeat(5000)));
    const res = await http.request({ url: `${urlBase}/info/refs?service=git-upload-pack`, method: "GET", headers: {} });
    expect(res.statusMessage).toContain("info/refs");
    expect(res.statusMessage).toContain(`body="${"x".repeat(200)}"`);
  });

  it("passes 2xx responses through untouched (body not read)", async () => {
    const inner = fake(200, "pack") as { request: (r: unknown) => Promise<{ body: unknown }> };
    const res0 = await inner.request({ url: `${urlBase}/git-upload-pack`, headers: {} });
    const http = withHttpEvidence({ request: async () => res0 } as never);
    const res = await http.request({ url: `${urlBase}/git-upload-pack`, headers: {} });
    expect(res).toBe(res0);
    expect(await read(res.body as never)).toBe("pack");
  });

  it("keeps the HttpError classifiable: clone against a 503 mentions HTTP Error: 503 and the evidence", async () => {
    const http = withHttpEvidence(fake(503, "overloaded", { "cf-ray": "r1" }));
    const err = await cloneRepo({ remote: `${urlBase}`, token: "art_v2_tok?expires=1", http }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/HTTP Error: 503 Service Unavailable \[HTTP 503 info\/refs cf-ray=r1 body="overloaded"\]/);
    expect(err?.message).not.toContain("art_v2_tok");
    expect((err as { data?: { statusCode?: number } }).data?.statusCode).toBe(503);
  });

  it("classifies endpoints", () => {
    expect(endpointKind(`${urlBase}/git-receive-pack`)).toBe("receive-pack");
    expect(endpointKind(`${urlBase}/info/refs?service=git-receive-pack`)).toBe("info/refs");
  });
});
