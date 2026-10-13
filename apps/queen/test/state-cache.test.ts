import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { spanIdFor, traceIdFromUuid, type WorkStatus } from "@queenos/queen-types";
import {
  rowToPrompt,
  rowToRelease,
  rowToTrain,
  upsertClaim,
  upsertEscalation,
  upsertHiveSettings,
  upsertPrompt,
  upsertRace,
  upsertRelease,
  upsertTrain,
  upsertWorkItem,
  deleteClaims,
} from "../src/db";
import type { QueenNode } from "../src/queen-node";
import type { EscalationRecord, HiveSettingsRecord, PathClaim, RaceRecord, WorkItemRecord } from "../src/records";
import { StateCache, type AppliedRows } from "../src/scale/state-cache";
import { statusOf, type PromptRecord, type TrainPhase, type TrainRecord } from "../src/train/planner";
import type { ReleaseRecord } from "../src/release/planner";

const newHive = () => `hive-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));

/** Deterministic PRNG so a failure reproduces from its seed. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Canonical records (what the row mappers return), used as templates. */
function templates(sql: SqlStorage, hive: string) {
  sql.exec("INSERT INTO prompt_runs (prompt_id, namespace, prompt_text, status, created_at, seq) VALUES ('ptpl', ?, 'text', 'QUEUED', 1, 1)", hive);
  sql.exec(
    `INSERT INTO merge_trains (train_id, base_sha, included_prompts, artifact_repo, status, created_at, seq, prompt_id, phase, fork_state, action, model, memories)
     VALUES ('tpl', 'base', '[]', 'repo', 'BUILDING', 1, 1, 'ptpl', 'BUILDING', 'READY', 'BUILD', '@cf/m', '[]')`,
  );
  sql.exec(
    `INSERT INTO releases (release_id, hive, head_sha, train_ids, phase, created_at, updated_at, seq) VALUES ('rtpl', ?, ?, '[]', 'STAGING', 1, 1, 1)`,
    hive,
    "b".repeat(40),
  );
  const train = rowToTrain(sql.exec("SELECT * FROM merge_trains WHERE train_id = 'tpl'").one());
  const prompt = rowToPrompt(sql.exec("SELECT * FROM prompt_runs WHERE prompt_id = 'ptpl'").one());
  const release = rowToRelease(sql.exec("SELECT * FROM releases WHERE release_id = 'rtpl'").one());
  sql.exec("DELETE FROM merge_trains");
  sql.exec("DELETE FROM prompt_runs");
  sql.exec("DELETE FROM releases");
  return { train, prompt, release };
}

function item(hive: string, id: string, seq: number, status: WorkStatus): WorkItemRecord {
  return {
    itemId: id, hive, kind: "feature", title: id, body: "", acceptance: [], priority: 2, status,
    parentId: null, rootId: id, depth: 0, dependsOn: [],
    source: { kind: "user", actor: "u" }, traceId: traceIdFromUuid(crypto.randomUUID()), spanId: spanIdFor(id),
    difficulty: "normal", bestOf: null, attempts: 0, conflicts: 0, paths: [], waitReason: null,
    duplicateOf: null, blockedReason: null, releaseId: null, escalationId: null,
    createdAt: 1, updatedAt: 1, seq, commandId: null, commandIssuedAt: null, normalizedTitle: id, landedAt: null, shippedAt: null,
  };
}

const PHASES: TrainPhase[] = ["WAITING_PARENT", "BUILDING", "DEPLOYING", "TESTING", "PASSED", "LANDING", "MERGED", "EJECTED"];
const WORK: WorkStatus[] = ["TRIAGE", "DECOMPOSING", "BLOCKED", "READY", "ACTIVE", "LANDED", "SHIPPED", "FAILED", "DUPLICATE", "CANCELLED"];
const WORK_TERMINAL = new Set(["SHIPPED", "DUPLICATE", "CANCELLED"]);
const REL = ["STAGING", "VALIDATING", "AWAITING_TAP", "CANARY", "SHIPPED", "FAILED", "ROLLED_BACK", "SUPERSEDED"] as const;
const REL_DONE = new Set(["SHIPPED", "FAILED", "ROLLED_BACK", "SUPERSEDED"]);

describe("StateCache", () => {
  it("equals a fresh load after random plan sequences (several seeds)", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const hive = newHive();
      await runInDurableObject(stubFor(hive), (q: QueenNode) => {
        const sql = q.sql;
        const rnd = mulberry32(seed);
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
        const tpl = templates(sql, hive);
        const settings = (n: number): HiveSettingsRecord => ({
          hive, autonomy: "autonomous", overrides: {}, budgetDay: null, creditsUsed: n, dispatches: n, autoFiledHour: null,
          autoFiledCount: 0, rollbackStreak: 0, degradedBy: [], updatedBy: null, updatedAt: n, leasedSlots: n, leaseExpiresAt: null, carInfraFailures: 0,
        });
        upsertHiveSettings(sql, settings(0));

        const cache = new StateCache();
        cache.load(sql);

        const trains = new Map<string, TrainRecord>();
        const prompts = new Map<string, PromptRecord>();
        const items = new Map<string, WorkItemRecord>();
        const races = new Map<string, RaceRecord>();
        const releases = new Map<string, ReleaseRecord>();
        const escs = new Map<string, EscalationRecord>();
        const claimed = new Map<string, PathClaim>();
        let trainSeq = 0, promptSeq = 0, itemSeq = 0, relSeq = 0, raceN = 0, escN = 0;

        for (let step = 0; step < 60; step++) {
          const rows: Required<{ [K in keyof AppliedRows]: NonNullable<AppliedRows[K]> extends readonly (infer U)[] ? U[] : never }> extends infer R ? { [K in keyof R]?: R[K] } : never = {};
          const out = rows as Record<string, unknown[]>;
          const add = (k: string, v: unknown) => (out[k] ??= []).push(v);
          const rowsSettings: { v?: HiveSettingsRecord } = {};

          for (let n = rnd() * 4; n > 0; n--) {
            const kind = Math.floor(rnd() * 7);
            if (kind === 0) {
              // new or advanced train (+ its prompt)
              const live = [...trains.values()].filter((t) => t.phase !== "MERGED" && t.phase !== "EJECTED");
              let t: TrainRecord;
              if (live.length && rnd() < 0.7) {
                const phase = pick(PHASES);
                t = { ...pick(live), phase, status: statusOf(phase) };
              } else {
                const id = `t${++trainSeq}`;
                t = { ...tpl.train, trainId: id, seq: trainSeq, promptId: `p${id}`, phase: "BUILDING", status: "BUILDING" };
              }
              trains.set(t.trainId, t);
              if (!prompts.has(t.promptId) || rnd() < 0.5) {
                const old = prompts.get(t.promptId);
                const p: PromptRecord = { ...tpl.prompt, promptId: t.promptId, seq: old?.seq ?? ++promptSeq, status: pick(["BUILDING", "IN_TRAIN", "MERGED", "EJECTED"] as const) };
                prompts.set(p.promptId, p);
                upsertPrompt(sql, p);
                add("prompts", p);
              }
              upsertTrain(sql, t);
              add("trains", t);
            } else if (kind === 1) {
              // a queued prompt, or a queued prompt that moves on
              const queued = [...prompts.values()].filter((p) => p.status === "QUEUED");
              const old = queued.length && rnd() < 0.5 ? pick(queued) : undefined;
              const p: PromptRecord = old
                ? { ...old, status: pick(["BUILDING", "FAILED"] as const) }
                : { ...tpl.prompt, promptId: `q${++promptSeq}`, seq: promptSeq, status: "QUEUED" };
              prompts.set(p.promptId, p);
              upsertPrompt(sql, p);
              add("prompts", p);
            } else if (kind === 2) {
              const live = [...items.values()].filter((w) => !WORK_TERMINAL.has(w.status));
              const w = live.length && rnd() < 0.7
                ? { ...pick(live), status: pick(WORK) }
                : item(hive, `i${++itemSeq}`, itemSeq, pick(WORK));
              items.set(w.itemId, w);
              upsertWorkItem(sql, w);
              add("items", w);
              if (w.status === "ACTIVE") {
                const c: PathClaim = { path: `src/${pick(["a", "b", "c"])}.ts`, itemId: w.itemId, source: "predicted", createdAt: 1 };
                upsertClaim(sql, c);
                claimed.set(`${c.path}|${c.itemId}`, c);
                add("claimsAdded", c);
              } else {
                deleteClaims(sql, w.itemId);
                for (const [k, c] of claimed) {
                  if (c.itemId === w.itemId) {
                    claimed.delete(k);
                    add("claimsReleased", c);
                  }
                }
              }
            } else if (kind === 3) {
              const live = [...races.values()].filter((r) => r.state === "RACING");
              const r: RaceRecord = live.length && rnd() < 0.6
                ? { ...pick(live), state: pick(["DECIDED", "ABANDONED"] as const) }
                : { raceId: `r${++raceN}`, itemId: "i1", width: 3, state: "RACING", trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: raceN, decidedAt: null };
              races.set(r.raceId, r);
              upsertRace(sql, r);
              add("races", r);
            } else if (kind === 4) {
              const live = [...releases.values()].filter((r) => !REL_DONE.has(r.phase));
              const r: ReleaseRecord = live.length && rnd() < 0.6
                ? { ...pick(live), phase: pick(REL) }
                : { ...tpl.release, releaseId: `rel${++relSeq}`, seq: relSeq, traceId: traceIdFromUuid(crypto.randomUUID()), phase: pick(REL) };
              releases.set(r.releaseId, r);
              upsertRelease(sql, r);
              add("releases", r);
            } else if (kind === 5) {
              const open = [...escs.values()].filter((e) => e.status === "OPEN");
              const e: EscalationRecord = open.length && rnd() < 0.5
                ? { ...pick(open), status: "RESOLVED", resolvedAt: step, resolvedBy: "u", resolution: "ship" }
                : {
                    escalationId: `e${++escN}`, hive, reason: "APPROVAL_REQUIRED", status: "OPEN", subject: { type: "release", id: "x" },
                    traceId: null, summary: "s", actions: ["ship"], createdAt: escN, resolvedAt: null, resolvedBy: null, resolution: null,
                  };
              escs.set(e.escalationId, e);
              upsertEscalation(sql, e);
              add("escalations", e);
            } else {
              const s = settings(step + 1);
              upsertHiveSettings(sql, s);
              rowsSettings.v = s;
            }
          }

          cache.apply({ ...(out as AppliedRows), settings: rowsSettings.v });
          expect(cache.get(), `seed ${seed} step ${step}`).toEqual(new StateCache().load(sql));
        }
      });
    }
  });

  it("is cold until loaded, ignores applies while cold and reloads after invalidate()", async () => {
    await runInDurableObject(stubFor(newHive()), (q: QueenNode) => {
      const sql = q.sql;
      const tpl = templates(sql, "h");
      const cache = new StateCache();
      expect(cache.get()).toBeNull();
      cache.apply({ trains: [tpl.train] });
      expect(cache.get()).toBeNull();

      upsertPrompt(sql, tpl.prompt);
      upsertTrain(sql, tpl.train);
      expect(cache.load(sql).trains.map((t) => t.trainId)).toEqual([tpl.train.trainId]);
      expect(cache.get()).not.toBeNull();

      cache.invalidate();
      expect(cache.get()).toBeNull();
      upsertTrain(sql, { ...tpl.train, phase: "MERGED", status: "MERGED" });
      expect(cache.load(sql).trains).toEqual([]);
    });
  });

  it("keeps REWORKING races warm (rework loop), on load and on apply; DECIDED and ABANDONED ones are evicted", async () => {
    await runInDurableObject(stubFor(newHive()), (q: QueenNode) => {
      const sql = q.sql;
      const race = (id: string, state: RaceRecord["state"]): RaceRecord => ({ raceId: id, itemId: "i1", width: 1, state, trainIds: [], winnerTrainId: null, reason: null, deadlineAt: null, createdAt: 1, decidedAt: null });
      upsertRace(sql, race("r1", "REWORKING"));
      upsertRace(sql, race("r2", "DECIDED"));
      const cache = new StateCache();
      expect(cache.load(sql).races.map((r) => r.raceId)).toEqual(["r1"]);
      cache.apply({ races: [race("r3", "REWORKING"), race("r1", "ABANDONED")] });
      expect(cache.get()!.races.map((r) => r.raceId)).toEqual(["r3"]);
    });
  });

  it("with 500 active trains a warm apply and read cost zero SQLite reads", async () => {
    await runInDurableObject(stubFor(newHive()), (q: QueenNode) => {
      const sql = q.sql;
      const tpl = templates(sql, "h");
      const train = (i: number): TrainRecord => ({ ...tpl.train, trainId: `t${i}`, seq: i, promptId: `p${i}` });
      for (let i = 1; i <= 500; i++) {
        upsertPrompt(sql, { ...tpl.prompt, promptId: `p${i}`, seq: i, status: "IN_TRAIN" });
        upsertTrain(sql, train(i));
      }
      const cache = new StateCache();
      expect(cache.load(sql).trains).toHaveLength(500);
      const loadReads = cache.sqlReads;
      expect(loadReads).toBeGreaterThan(0);

      // One reportBuildResult-shaped apply: a train moves on, another is evicted.
      cache.apply({ trains: [{ ...train(7), phase: "PASSED", status: "TESTING" }, { ...train(8), phase: "MERGED", status: "MERGED" }] });
      const s = cache.get()!;
      expect(s.trains).toHaveLength(499);
      expect(s.prompts).toHaveLength(499);
      expect(s.trains.find((t) => t.trainId === "t7")?.phase).toBe("PASSED");
      expect(s.maxTrainSeq).toBe(500);
      expect(cache.sqlReads).toBe(loadReads);
    });
  });
});
