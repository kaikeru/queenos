/** Rework loop: attemptSyncBase (rework-loop spec §6.1) and rejectRace + its route (§7.4). */
import { exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseNotes } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import { BASE_SHA, OTHER, OWNER, agent, externalHive, fileItem, gateFail, gatePass, goLive, look, own, push, readyAttempt, rpcError, stubFor } from "./attempt-helpers";

const baseOfTrain = (ns: string, trainId: string) => runInDurableObject(stubFor(ns), (q: QueenNode) => String(q.sql.exec("SELECT base_sha FROM merge_trains WHERE train_id = ?", trainId).one().base_sha));
const MAIN = "e".repeat(40);

describe("attemptSyncBase (§6.1)", () => {
  it("READY: records the attempt's base (the item's base untouched); the next push is gated against it; PUSHED is CONFLICT", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: true, changed: true, attempt: { state: "READY", baseSha: MAIN } });
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: true, changed: false });
    expect((await look(ns)).items.find((i) => i.item_id === itemId)!.base_sha).toBe(BASE_SHA);
    expect((await look(ns)).events.some((e) => e.type === "attempt.state" && (JSON.parse(e.data ?? "null") as { syncBase?: boolean } | null)?.syncBase === true)).toBe(true);
    const { res } = await push(ns, a);
    expect(await baseOfTrain(ns, res.trainId!)).toBe(MAIN);
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: "f".repeat(40) })).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("REJECTED with an open slot is allowed; without one it is CONFLICT; another agent FORBIDDEN_OWNER; terminal ATTEMPT_EXPIRED", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    await push(ns, a);
    await goLive(ns, a.trainId);
    await gateFail(ns, a.trainId);
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: true, changed: true });
    expect(await stub.attemptSyncBase({ ...own(ns, a), agentId: agent().agentId, baseSha: MAIN })).toMatchObject({ ok: false, code: "FORBIDDEN_OWNER" });
    await stub.attemptEnd(own(ns, a));
    expect(await stub.attemptSyncBase({ ...own(ns, a), baseSha: MAIN })).toMatchObject({ ok: false, code: "ATTEMPT_EXPIRED" });

    const z = await externalHive({ race: { entryWindowMs: 0 }, guardrails: { maxReworksPerAttempt: 0 } });
    const zi = await fileItem(z.ns);
    const za = await readyAttempt(z.ns, zi);
    await push(z.ns, za);
    await goLive(z.ns, za.trainId);
    await gateFail(z.ns, za.trainId);
    expect(await z.stub.attemptSyncBase({ ...own(z.ns, za), baseSha: MAIN })).toMatchObject({ ok: false, code: "CONFLICT" });
  });
});

const worker = exports.default;
const rejectRoute = (hive: string, raceId: string, body: unknown, user?: string) =>
  worker.fetch(`http://queen.test/hives/${hive}/races/${raceId}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user === undefined ? {} : { "x-queen-user": user }) },
    body: JSON.stringify(body),
  });

/** Judge human, two agents pass: the race is PICKING. */
async function pickingRace() {
  const { ns, stub } = await externalHive({ race: { entryWindowMs: 0, judge: "human" } });
  const itemId = await fileItem(ns);
  const a = await readyAttempt(ns, itemId);
  const b = await readyAttempt(ns, itemId, agent({ owner: OTHER, name: "kimi" }));
  await push(ns, a);
  await push(ns, b);
  await gatePass(ns, a.trainId);
  await gatePass(ns, b.trainId);
  const raceId = String((await look(ns)).races.at(-1)!.race_id);
  expect((await look(ns)).races.at(-1)).toMatchObject({ state: "PICKING" });
  return { ns, stub, itemId, a, b, raceId };
}

describe("rejectRace (§7.4)", () => {
  it("reject one: the candidate's attempt is REJECTED (human) with a slot; the race drops to RACING; a second reject is CONFLICT", async () => {
    const { ns, stub, a, b, raceId } = await pickingRace();
    const r = await stub.rejectRace({ hive: ns, raceId, user: OWNER, reject: { trainId: b.trainId, reason: "the jar overlaps the footer" } });
    expect(r).toMatchObject({ outcome: "applied", fallback: false, race: { state: "RACING", reopens: 1, rejections: [{ trainId: b.trainId, by: `human:${OWNER}`, reason: "the jar overlaps the footer" }] } });
    expect(await stub.getAttempt(b.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "human", rework: { reason: "human", round: 1 } });
    expect((await look(ns)).events.filter((e) => e.type === "race.rejected")).toHaveLength(1);
    expect(await rpcError(stub.rejectRace({ hive: ns, raceId, user: OWNER, reject: { trainId: a.trainId, reason: "x" } }))).toMatch(/^CONFLICT: /);
    expect(await rpcError(stub.rejectRace({ hive: ns, raceId: "nope", user: OWNER, reject: { trainId: "all", reason: "x" } }))).toMatch(/^NOT_FOUND: /);
  });

  it("reject all: every candidate in rework, the window reopens; past maxRaceReopens it falls back (fallback: true)", async () => {
    const { ns, stub, raceId } = await pickingRace();
    const r = await stub.rejectRace({ hive: ns, raceId, user: OWNER, reject: { trainId: "all", reason: "none handles an empty cart" } });
    expect(r).toMatchObject({ fallback: false, race: { state: "RACING", reopens: 1 } });
    expect(r.race.pickDeadlineAt ?? null).toBeNull();
    expect(r.race.entryClosesAt).toBeGreaterThan(Date.now());

    const z = await externalHive({ race: { entryWindowMs: 0, judge: "human" }, guardrails: { maxRaceReopens: 0 } });
    const zi = await fileItem(z.ns);
    const za = await readyAttempt(z.ns, zi);
    const zb = await readyAttempt(z.ns, zi, agent({ owner: OTHER, name: "kimi" }));
    await push(z.ns, za);
    await push(z.ns, zb);
    await gatePass(z.ns, za.trainId);
    await gatePass(z.ns, zb.trainId);
    const zr = String((await look(z.ns)).races.at(-1)!.race_id);
    expect(await z.stub.rejectRace({ hive: z.ns, raceId: zr, user: OWNER, reject: { trainId: "all", reason: "no" } })).toMatchObject({ fallback: true, race: { state: "ABANDONED" } });
    expect((await look(z.ns)).items.find((i) => i.item_id === zi)).toMatchObject({ status: "FAILED" });
  });

  it("is a user route: 401 without x-queen-user, 400 on an empty or long reason, 404 for an unknown race", async () => {
    const hive = `route-${crypto.randomUUID().slice(0, 8)}`;
    expect((await rejectRoute(hive, "r1", { trainId: "t", reason: "x" })).status).toBe(401);
    expect((await rejectRoute(hive, "r1", { trainId: "t", reason: "" }, OWNER)).status).toBe(400);
    expect((await rejectRoute(hive, "r1", { trainId: "t", reason: "  \n " }, OWNER)).status).toBe(400);
    expect((await rejectRoute(hive, "r1", { trainId: "t", reason: "x".repeat(301) }, OWNER)).status).toBe(400);
    const res = await rejectRoute(hive, "r1", { trainId: "all", reason: "x" }, OWNER);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("closed-slot note wording (F9 round 1)", () => {
  it("a real push that closes the slot leaves the old train's note neutral, never claiming the item reopened", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId);
    const first = await push(ns, a);
    await goLive(ns, a.trainId);
    await gateFail(ns, a.trainId);
    const fix = await push(ns, a);
    expect(fix.res.trainId).not.toBe(a.trainId);
    const text = (await stub.notesFor(ns, "refs/notes/verdict")).notes.find((n) => n.sha === first.after)!.text;
    const bodies = parseNotes(text).map((e) => e.body);
    expect(bodies.at(-1)).toBe("This rework slot is closed. If you pushed a fix, follow that push's verdict; otherwise check get_item: the item may take new attempts.");
    expect(bodies.join("\n")).not.toMatch(/reopened/);
  });
});
