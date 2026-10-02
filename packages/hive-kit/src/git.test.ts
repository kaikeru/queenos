import { describe, expect, it } from "vitest";
import { GitError, NOTES_REF, artifactsAuth, assertRepoPath, initRepo, stripTokenExpiry } from "./git.js";

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
