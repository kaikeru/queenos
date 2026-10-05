/**
 * LANDER (`landTrain`) for a multi-member merge-queue car, on real
 * isomorphic-git over MemFS with in-memory smart-HTTP remotes.
 */
import { describe, expect, it } from "vitest";
import { DroneTaskSchema, LAND_DEPTH as SHARED_LAND_DEPTH, type MergeMember } from "@queenos/queen-types";
import { MemoryGitServer, NOTES_REF, cloneRepo, renderRegistry, type GitRepo } from "@queenos/hive-kit";
import { LAND_DEPTH, landTrain } from "../src/land";
import { mergeCar } from "../src/merge";
import type { DronePorts, GitPort } from "../src/ports";
import { FakeArtifacts, STARTER_FILES, T0_SECONDS, remoteOf } from "./fakes";

const CAR = "hive-car-1";

class GitWorld {
  readonly server = new MemoryGitServer();
  readonly artifacts = new FakeArtifacts();
  readonly git: GitPort = {
    clone: (req) => cloneRepo({ remote: req.remote, token: req.token, http: this.server.http, ...(req.ref ? { ref: req.ref } : {}), depth: req.depth ?? 1 }),
  };
  ports(): Pick<DronePorts, "artifacts" | "git"> {
    return { artifacts: this.artifacts, git: this.git };
  }
  work(repo: string): Promise<GitRepo> {
    return cloneRepo({ remote: remoteOf(repo), http: this.server.http, ref: "main", depth: 0 });
  }
  async fork(repo: string): Promise<void> {
    await this.server.create(remoteOf(repo));
    await (await this.work("hive")).push({ ref: "main", remote: { url: remoteOf(repo) } });
  }
  async member(trainId: string, name: string, ts: number): Promise<MergeMember> {
    const artifactRepo = `hive-train-${trainId}`;
    await this.fork(artifactRepo);
    const w = await this.work(artifactRepo);
    await w.writeFiles([
      { path: `src/features/${name}`, content: `export const slug = "${name}";\n` },
      { path: "src/features/index.js", content: renderRegistry([name]) },
    ]);
    const headSha = await w.commitAll({ message: `build ${trainId}`, timestamp: ts });
    await w.push({ ref: "main" });
    await w.addNote({ oid: headSha, note: `ledger ${trainId}`, timestamp: ts });
    await w.pushNotes();
    return { trainId, promptId: `p-${trainId}`, artifactRepo, headSha, title: name };
  }
}

const task = (members: MergeMember[], baseRef: string, action: "MERGE" | "LAND") =>
  DroneTaskSchema.parse({
    promptId: "car-1",
    trainId: "car-1",
    namespace: "hive",
    artifactRepo: CAR,
    baseRef,
    promptText: `queue car car-1: ${members.length} members`,
    role: "LANDER",
    action,
    members,
  });

async function mergedCar(g: GitWorld, n = 3) {
  const hive = await g.server.create(remoteOf("hive"));
  await hive.writeFiles(Object.entries(STARTER_FILES).map(([path, content]) => ({ path, content })));
  await hive.commitAll({ message: "seed", timestamp: T0_SECONDS - 3600 });
  await g.fork(CAR);
  const members: MergeMember[] = [];
  for (let i = 1; i <= n; i++) members.push(await g.member(`t${i}`, `f${i}.js`, T0_SECONDS + i));
  const r = await mergeCar(g.ports(), task(members, "main", "MERGE"), T0_SECONDS + 100);
  return { hive, members, headSha: r.headSha! };
}

describe("landTrain (merge-queue car)", () => {
  it("uses the shared LAND_DEPTH", () => {
    expect(LAND_DEPTH).toBe(SHARED_LAND_DEPTH);
  });

  it("lands a 3-member car with one fast-forward and carries every member's ledger note", async () => {
    const g = new GitWorld();
    const { hive, members, headSha } = await mergedCar(g);
    const out = await landTrain(g.ports(), task(members, headSha, "LAND"), T0_SECONDS + 200);

    expect(out).toMatchObject({ landed: true, mainSha: headSha, notesCarried: 3 });
    expect(out.notesError).toBeUndefined();
    expect(await hive.resolveRef("main")).toBe(headSha);
    for (const m of members) expect(await hive.readNote(m.headSha, NOTES_REF)).toBe(`ledger ${m.trainId}`);
    expect(g.artifacts.calls.filter((c) => c.scope === "read").map((c) => c.repo)).toEqual(
      expect.arrayContaining([CAR, ...members.map((m) => m.artifactRepo)]),
    );
  });

  it("keeps notes already on the hive", async () => {
    const g = new GitWorld();
    const { hive, members, headSha } = await mergedCar(g, 2);
    const seed = await hive.resolveRef("main");
    await hive.addNote({ oid: seed, note: "older ledger", timestamp: T0_SECONDS });
    const out = await landTrain(g.ports(), task(members, headSha, "LAND"), T0_SECONDS + 200);
    expect(out).toMatchObject({ landed: true, notesCarried: 2 });
    expect(await hive.readNote(seed)).toBe("older ledger");
    expect(await hive.readNote(members[1]!.headSha)).toBe("ledger t2");
  });

  it("main moved under the car → not landed (NOT_FAST_FORWARD), nothing pushed", async () => {
    const g = new GitWorld();
    const { hive, members, headSha } = await mergedCar(g, 2);
    await hive.writeFiles([{ path: "hotfix.txt", content: "human push\n" }]);
    const moved = await hive.commitAll({ message: "hotfix", timestamp: T0_SECONDS + 150 });
    const out = await landTrain(g.ports(), task(members, headSha, "LAND"), T0_SECONDS + 200);
    expect(out).toMatchObject({ landed: false, notesCarried: 0 });
    expect(out.summary).toContain("not a fast-forward");
    expect(await hive.resolveRef("main")).toBe(moved);
  });

  it("a denied notes push still lands, with notesError", async () => {
    const g = new GitWorld();
    const { members, headSha } = await mergedCar(g, 2);
    g.server.deny = (url, ref) => (url === remoteOf("hive") && ref.startsWith("refs/notes/") ? "deny refs/notes" : undefined);
    const out = await landTrain(g.ports(), task(members, headSha, "LAND"), T0_SECONDS + 200);
    expect(out).toMatchObject({ landed: true, mainSha: headSha, notesCarried: 0 });
    expect(out.notesError).toContain("deny refs/notes");
  });
});
