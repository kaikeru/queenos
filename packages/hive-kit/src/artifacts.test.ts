import { describe, expect, it } from "vitest";
import { RepoNotFoundError, deleteRepoQuietly, errorCode, forkRepo, type ForkArtifacts, type ForkDeps, type ForkRepoHandle } from "./artifacts.js";

class CodeErr extends Error {
  constructor(readonly code: string) {
    super(`${code}: fake`);
  }
}

const HEAD = "a".repeat(40);

class FakeArtifacts implements ForkArtifacts {
  repos = new Map<string, { main: string; readOnly: boolean }>([["hive", { main: HEAD, readOnly: false }]]);
  forks: { name: string; opts: unknown }[] = [];
  deleted: string[] = [];
  /** Fork names whose fork() throws this code once. */
  forkErrors = new Map<string, string>();
  /** Repo name -> get() calls that still answer FORK_IN_PROGRESS. */
  inProgress = new Map<string, number>();
  async get(name: string): Promise<ForkRepoHandle> {
    const left = this.inProgress.get(name) ?? 0;
    if (left > 0) {
      this.inProgress.set(name, left - 1);
      throw new CodeErr("FORK_IN_PROGRESS");
    }
    const st = this.repos.get(name);
    if (!st) throw new CodeErr("NOT_FOUND");
    return {
      [Symbol.dispose]() {},
      log: async ({ ref } = {}) => (ref === "main" ? [{ hash: st.main }] : []),
      fork: async (fname, opts) => {
        const err = this.forkErrors.get(fname);
        if (err) {
          this.forkErrors.delete(fname);
          throw new CodeErr(err);
        }
        if (this.repos.has(fname)) throw new CodeErr("ALREADY_EXISTS");
        this.forks.push({ name: fname, opts });
        this.repos.set(fname, { main: st.main, readOnly: !!opts?.readOnly });
        return {};
      },
    };
  }
  async delete(name: string) {
    this.deleted.push(name);
    return this.repos.delete(name);
  }
}

function deps(art: FakeArtifacts, sick: ReadonlySet<string> = new Set()) {
  let clock = 0;
  const sleeps: number[] = [];
  const forgotten: string[] = [];
  const probed: string[] = [];
  const d: ForkDeps = {
    artifacts: art,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    forget: (r) => void forgotten.push(r),
    probeStatus: async (repo) => {
      probed.push(repo);
      return sick.has(repo) ? { status: 503, ray: "8f00ray" } : { status: 200, ray: null };
    },
  };
  return { d, sleeps, forgotten, probed };
}

const NAME = "hive-att-0123456789ab";

describe("forkRepo", () => {
  it("forks the source's default branch under the name, probes it and returns its head", async () => {
    const art = new FakeArtifacts();
    const { d, probed } = deps(art);
    expect(await forkRepo(d, "hive", "main", NAME, { description: "attempt" })).toEqual({ repo: NAME, baseSha: HEAD, attempted: [NAME] });
    expect(art.forks).toEqual([{ name: NAME, opts: { defaultBranchOnly: true, description: "attempt" } }]);
    expect(probed).toEqual([NAME]);
  });

  it("a read-only fork passes readOnly; probe:false skips the receive-pack probe", async () => {
    const art = new FakeArtifacts();
    const { d, probed } = deps(art, new Set(["hive-base-0123456789ab"]));
    const r = await forkRepo(d, "hive", "main", "hive-base-0123456789ab", { readOnly: true, probe: false });
    expect(r.repo).toBe("hive-base-0123456789ab");
    expect(art.forks[0]!.opts).toMatchObject({ readOnly: true, defaultBranchOnly: true });
    expect(probed).toEqual([]);
  });

  it("a sick fork is deleted (credentials forgotten) and re-forked as -r2; three sick names fail with the cf-ray", async () => {
    const art = new FakeArtifacts();
    const { d, forgotten } = deps(art, new Set([NAME]));
    expect((await forkRepo(d, "hive", "main", NAME, { probeBudgetMs: 3000 })).repo).toBe(`${NAME}-r2`);
    expect(art.deleted).toEqual([NAME]);
    expect(forgotten).toEqual([NAME]);
    const all = new FakeArtifacts();
    const sick = deps(all, new Set([NAME, `${NAME}-r2`, `${NAME}-r3`]));
    await expect(forkRepo(sick.d, "hive", "main", NAME, { probeBudgetMs: 3000 })).rejects.toThrow(/failed after 3 tries.*cf-ray=8f00ray/);
    expect(all.deleted).toEqual([NAME, `${NAME}-r2`, `${NAME}-r3`]);
  });

  it("a ghost name (INTERNAL_ERROR on fork) re-forks; ALREADY_EXISTS reuses the fork; FORK_IN_PROGRESS is waited out", async () => {
    const ghost = new FakeArtifacts();
    ghost.forkErrors.set(NAME, "INTERNAL_ERROR");
    expect((await forkRepo(deps(ghost).d, "hive", "main", NAME)).repo).toBe(`${NAME}-r2`);
    const reuse = new FakeArtifacts();
    reuse.repos.set(NAME, { main: HEAD, readOnly: false });
    expect(await forkRepo(deps(reuse).d, "hive", "main", NAME)).toMatchObject({ repo: NAME, baseSha: HEAD });
    expect(reuse.forks).toEqual([]);
    const slow = new FakeArtifacts();
    slow.inProgress.set(NAME, 3);
    const s = deps(slow);
    expect((await forkRepo(s.d, "hive", "main", NAME)).repo).toBe(NAME);
    expect(s.sleeps.slice(0, 3)).toEqual([250, 500, 1000]);
  });

  it("a missing source is RepoNotFoundError", async () => {
    await expect(forkRepo(deps(new FakeArtifacts()).d, "nope", "main", NAME)).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});

describe("errorCode / deleteRepoQuietly", () => {
  it("reads .code or a CODE: prefix; deleteRepoQuietly swallows errors", async () => {
    expect(errorCode(new CodeErr("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(errorCode(new Error("FORK_IN_PROGRESS: busy"))).toBe("FORK_IN_PROGRESS");
    expect(errorCode(new Error("boom"))).toBeNull();
    const art = { get: async () => { throw new Error("x"); }, delete: async () => { throw new Error("down"); } } as unknown as ForkArtifacts;
    await expect(deleteRepoQuietly({ artifacts: art }, "r")).resolves.toBeUndefined();
  });
});
