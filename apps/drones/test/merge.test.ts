/**
 * MERGE drone (`mergeCar`) on real isomorphic-git over MemFS: every remote is
 * a hive-kit MemoryGitServer repo spoken to over in-memory smart HTTP, so
 * clone, shallow fetch, deepen and push all run the real protocol.
 */
import { describe, expect, it } from "vitest";
import { DroneTaskSchema, LAND_DEPTH, type MergeMember } from "@queenos/queen-types";
import { MemoryGitServer, cloneRepo, renderRegistry, type GitRepo } from "@queenos/hive-kit";
import { mergeCar, mergeMessage } from "../src/merge";
import { defaultMergeCar } from "../src/merge-adapter";
import type { DronePorts, GitPort } from "../src/ports";
import { FakeArtifacts, STARTER_FILES, T0_SECONDS, remoteOf } from "./fakes";

const REG = "src/features/index.js";
const CAR = "hive-car-1";

class GitWorld {
  readonly server = new MemoryGitServer();
  readonly artifacts = new FakeArtifacts();
  readonly clones: { remote: string; depth?: number }[] = [];
  readonly git: GitPort = {
    clone: (req) => {
      this.clones.push({ remote: req.remote, ...(req.depth !== undefined ? { depth: req.depth } : {}) });
      return cloneRepo({ remote: req.remote, token: req.token, http: this.server.http, ...(req.ref ? { ref: req.ref } : {}), depth: req.depth ?? 1 });
    },
  };
  ports(): Pick<DronePorts, "artifacts" | "git"> {
    return { artifacts: this.artifacts, git: this.git };
  }

  /** The hive repo with the starter template on main. */
  async hive(files: Record<string, string> = STARTER_FILES): Promise<string> {
    const repo = await this.server.create(remoteOf("hive"));
    await repo.writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
    return repo.commitAll({ message: "seed", timestamp: T0_SECONDS - 3600 });
  }

  /** A full clone of a remote's main. */
  work(repo: string): Promise<GitRepo> {
    return cloneRepo({ remote: remoteOf(repo), http: this.server.http, ref: "main", depth: 0 });
  }

  /** Fork `from`'s main into a new remote `repo` (what the Provisioner does). */
  async fork(repo: string, from = "hive"): Promise<void> {
    await this.server.create(remoteOf(repo));
    const w = await this.work(from);
    await w.push({ ref: "main", remote: { url: remoteOf(repo) } });
  }

  /** A member: fork hive, commit `files`, push, leave a ledger note. */
  async member(trainId: string, files: Record<string, string>, ts: number, title = trainId): Promise<MergeMember> {
    const artifactRepo = `hive-train-${trainId}`;
    await this.fork(artifactRepo);
    const w = await this.work(artifactRepo);
    await w.writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
    const headSha = await w.commitAll({ message: `build ${trainId}`, timestamp: ts });
    await w.push({ ref: "main" });
    await w.addNote({ oid: headSha, note: JSON.stringify({ trainId }), timestamp: ts });
    await w.pushNotes();
    return { trainId, promptId: `p-${trainId}`, artifactRepo, headSha, title };
  }

  /** Commit straight onto a remote's main. */
  async advance(repo: string, files: Record<string, string>, ts: number): Promise<string> {
    const r = this.server.repo(remoteOf(repo));
    await r.writeFiles(Object.entries(files).map(([path, content]) => ({ path, content })));
    return r.commitAll({ message: `advance ${ts}`, timestamp: ts });
  }

  main(repo: string): Promise<string> {
    return this.server.repo(remoteOf(repo)).resolveRef("main");
  }
}

/** A feature module plus its registry line, as a builder would write it on top of the starter. */
const feature = (name: string) => ({ [`src/features/${name}`]: `export const slug = "${name.replace(".js", "")}";\n`, [REG]: renderRegistry([name]) });

const carTask = (members: MergeMember[]) =>
  DroneTaskSchema.parse({
    promptId: "car-1",
    trainId: "car-1",
    namespace: "hive",
    artifactRepo: CAR,
    baseRef: "main",
    promptText: `queue car car-1: ${members.length} members`,
    role: "LANDER",
    action: "MERGE",
    members,
  });

const TS = T0_SECONDS + 500;

async function fourMembers(g: GitWorld) {
  await g.hive();
  await g.fork(CAR);
  const members = [];
  for (const [i, n] of ["a.js", "b.js", "c.js", "d.js"].entries()) members.push(await g.member(`t${i + 1}`, feature(n), T0_SECONDS + i, `Feature ${n}`));
  return members;
}

describe("mergeCar", () => {
  it("is the drones' default MERGE implementation", () => {
    expect(defaultMergeCar).toBe(mergeCar);
  });

  it("merges 4 clean members: the first fast-forwards, the rest are merge commits; the registry is the union", async () => {
    const g = new GitWorld();
    const members = await fourMembers(g);
    const base = await g.main(CAR);
    const r = await mergeCar(g.ports(), carTask(members), TS);

    expect(r).toMatchObject({ trainId: "car-1", ok: true, baseSha: base, merged: ["t1", "t2", "t3", "t4"], conflicts: [], fastForward: false });
    expect(r.headSha).toBe(await g.main(CAR));
    expect(g.clones[0]).toEqual({ remote: remoteOf(CAR), depth: LAND_DEPTH });

    const car = await g.work(CAR);
    const head = await car.head();
    expect(head?.parents).toEqual([expect.any(String), members[3]!.headSha]);
    expect(head?.message.trim()).toBe(mergeMessage("car-1", members[3]!));
    // First-parent chain: 3 merge commits, then t1's head (the fast-forward), then the base.
    let c = head!;
    const chain: string[] = [];
    while (c.oid !== base) {
      chain.push(c.oid);
      c = (await car.readCommit(c.parents[0]!))!;
    }
    expect(chain).toHaveLength(4);
    expect(chain[3]).toBe(members[0]!.headSha);
    expect((await car.readFiles([REG]))[REG]).toBe(renderRegistry(["a.js", "b.js", "c.js", "d.js"]));
    expect(await car.listFiles()).toEqual(expect.arrayContaining(["src/features/a.js", "src/features/d.js"]));
  });

  it("a content conflict on member 3 is recorded with its paths; the others merge and main never sees it", async () => {
    const g = new GitWorld();
    await g.hive();
    await g.fork(CAR);
    const edit = (to: string) => ({ "src/index.js": STARTER_FILES["src/index.js"]!.replace('app: "worker-starter"', `app: "${to}"`) });
    const m1 = await g.member("t1", { ...feature("a.js"), ...edit("one") }, T0_SECONDS + 1);
    const m2 = await g.member("t2", feature("b.js"), T0_SECONDS + 2);
    const m3 = await g.member("t3", edit("three-is-longer"), T0_SECONDS + 3);
    const m4 = await g.member("t4", feature("d.js"), T0_SECONDS + 4);

    const r = await mergeCar(g.ports(), carTask([m1, m2, m3, m4]), TS);
    expect(r.merged).toEqual(["t1", "t2", "t4"]);
    expect(r.conflicts).toEqual([{ trainId: "t3", kind: "content", paths: ["src/index.js"], summary: expect.stringContaining("src/index.js") }]);
    const car = await g.work(CAR);
    expect((await car.readFiles(["src/index.js"]))["src/index.js"]).toContain('app: "one"');
    expect(await car.readCommit(m3.headSha)).toBeNull(); // t3 is not in the car's history
  });

  it("add/add of one path with different content is unsupported, with the path", async () => {
    const g = new GitWorld();
    await g.hive();
    await g.fork(CAR);
    const m1 = await g.member("t1", { "src/theme.js": "export const theme = 'dark';\n" }, T0_SECONDS + 1);
    const m2 = await g.member("t2", { "src/theme.js": "export const theme = 'solarized';\n" }, T0_SECONDS + 2);
    const r = await mergeCar(g.ports(), carTask([m1, m2]), TS);
    expect(r.merged).toEqual(["t1"]);
    expect(r.conflicts).toEqual([{ trainId: "t2", kind: "unsupported", paths: ["src/theme.js"], summary: expect.stringContaining("both add") }]);
  });

  it("two features both registering in src/features/index.js do not conflict", async () => {
    const g = new GitWorld();
    await g.hive();
    await g.fork(CAR);
    const m1 = await g.member("t1", feature("dark-mode.js"), T0_SECONDS + 1);
    const m2 = await g.member("t2", feature("clock.js"), T0_SECONDS + 2);
    const r = await mergeCar(g.ports(), carTask([m1, m2]), TS);
    expect(r).toMatchObject({ merged: ["t1", "t2"], conflicts: [] });
    const car = await g.work(CAR);
    expect((await car.readFiles([REG]))[REG]).toBe(renderRegistry(["clock.js", "dark-mode.js"]));
  });

  it("a replay with the same timestamp makes identical SHAs (fresh world, and replay on the pushed car)", async () => {
    const run = async () => {
      const g = new GitWorld();
      const members = await fourMembers(g);
      return { g, members, r: await mergeCar(g.ports(), carTask(members), TS) };
    };
    const a = await run();
    const b = await run();
    expect(b.r.headSha).toBe(a.r.headSha);
    // A step retried after its push: everything is already merged, nothing moves.
    const again = await mergeCar(a.g.ports(), carTask(a.members), TS);
    expect(again).toMatchObject({ ok: true, headSha: a.r.headSha, merged: ["t1", "t2", "t3", "t4"], conflicts: [] });
  });

  it("a single fast-forwarded member is the fast path", async () => {
    const g = new GitWorld();
    await g.hive();
    await g.fork(CAR);
    const m1 = await g.member("t1", feature("a.js"), T0_SECONDS + 1);
    const r = await mergeCar(g.ports(), carTask([m1]), TS);
    expect(r).toMatchObject({ merged: ["t1"], fastForward: true, headSha: m1.headSha });
  });

  it("a member whose head is not on its fork is missing", async () => {
    const g = new GitWorld();
    await g.hive();
    await g.fork(CAR);
    const m1 = await g.member("t1", feature("a.js"), T0_SECONDS + 1);
    const ghost = { ...m1, trainId: "t2", headSha: "f".repeat(40) };
    const r = await mergeCar(g.ports(), carTask([ghost, m1]), TS);
    expect(r.merged).toEqual(["t1"]);
    expect(r.conflicts).toEqual([expect.objectContaining({ trainId: "t2", kind: "missing", paths: [] })]);
  });

  it("nothing merged → nothing pushed", async () => {
    const g = new GitWorld();
    await g.hive();
    await g.fork(CAR);
    const base = await g.main(CAR);
    const m1 = await g.member("t1", feature("a.js"), T0_SECONDS + 1);
    const r = await mergeCar(g.ports(), carTask([{ ...m1, headSha: "e".repeat(40) }]), TS);
    expect(r).toMatchObject({ ok: true, merged: [], headSha: base, baseSha: base, fastForward: false });
    expect(g.server.pushes.filter((p) => p.url === remoteOf(CAR) && p.ref === "refs/heads/main")).toHaveLength(1); // only the fork itself
  });

  it(`a base deeper than LAND_DEPTH (${LAND_DEPTH}) is deepened, then merged`, async () => {
    const g = new GitWorld();
    await g.hive();
    const m1 = await g.member("t1", feature("a.js"), T0_SECONDS + 1);
    // Main moves on by more than LAND_DEPTH commits before the car forks.
    for (let i = 0; i < LAND_DEPTH + 1; i++) await g.advance("hive", { "log.txt": `${"x".repeat(i + 1)}\n` }, T0_SECONDS + 10 + i);
    await g.fork(CAR);
    const r = await mergeCar(g.ports(), carTask([m1]), TS);
    expect(r).toMatchObject({ merged: ["t1"], conflicts: [], fastForward: false });
    const car = await g.work(CAR);
    expect((await car.head())?.parents).toEqual([await g.main("hive"), m1.headSha]);
  }, 60_000);
});
