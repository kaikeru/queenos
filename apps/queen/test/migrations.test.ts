import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GitNotesPayloadSchema, QueenServerMessageSchema, spanIdFor, traceIdFromUuid, type AuditEvent } from "@queenos/queen-types";
import {
  ESCALATION_SELECT,
  SCHEMA_VERSION,
  appendAuditRow,
  canonicalLabels,
  deleteClaims,
  insertEvent,
  listRecentAudit,
  loadHiveSettings,
  migrate,
  rowToAudit,
  rowToClaim,
  rowToEscalation,
  rowToEvent,
  rowToMetric,
  rowToPrompt,
  upsertPrompt,
  rowToRace,
  rowToRelease,
  rowToTrain,
  rowToWorkItem,
  upsertClaim,
  upsertEscalation,
  upsertHiveSettings,
  upsertMetric,
  upsertRace,
  upsertTrain,
  upsertWorkItem,
} from "../src/db";
import type { QueenNode } from "../src/queen-node";
import type { WorkItemRecord } from "../src/records";
import { toRelease } from "../src/release/planner";
import { toMergeTrain, toPromptRun } from "../src/train/planner";

const newHive = () => `hive-${crypto.randomUUID().slice(0, 8)}`;
const stubFor = (ns: string) => env.QUEEN_NODE.get(env.QUEEN_NODE.idFromName(ns));

/** Drop every table the migrations created (dependents first), so migrate() can rebuild from v0. */
function resetToEmpty(sql: SqlStorage): void {
  const tables = sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .toArray()
    .map((r) => String(r.name));
  const order = (t: string) => (t === "prompt_runs" ? 1 : 0);
  for (const t of tables.sort((a, b) => order(a) - order(b))) sql.exec(`DROP TABLE "${t}"`);
}

const tables = (sql: SqlStorage) =>
  new Set(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => String(r.name)));
const columns = (sql: SqlStorage, table: string) =>
  new Set(sql.exec(`SELECT name FROM pragma_table_info('${table}')`).toArray().map((r) => String(r.name)));
const version = (sql: SqlStorage) => Number(sql.exec("SELECT MAX(version) AS v FROM _migrations").one().v);

describe("migrations", () => {
  it("a fresh DO migrates to v13", async () => {
    expect(SCHEMA_VERSION).toBe(13);
    await runInDurableObject(stubFor(newHive()), (q: QueenNode, state) => {
      expect(version(q.sql)).toBe(13);
      const t = tables(q.sql);
      for (const name of ["work_items", "races", "hive_settings", "escalations", "event_log", "metrics_hourly", "path_claims"]) {
        expect(t.has(name), name).toBe(true);
      }
      for (const c of ["trace_id", "race_id", "candidate", "race_outcome", "gate_score", "credits", "lane", "members", "car_id", "passed_seq", "conflict", "changed_paths", "wait_for_car_seq", "bisect_of", "verified", "passed_at"]) {
        expect(columns(q.sql, "merge_trains").has(c), c).toBe(true);
      }
      for (const c of ["paths", "wait_reason", "conflicts"]) expect(columns(q.sql, "work_items").has(c), c).toBe(true);
      for (const c of ["leased_slots", "lease_expires_at", "car_infra_failures", "budget_boost"]) expect(columns(q.sql, "hive_settings").has(c), c).toBe(true);
      expect(columns(q.sql, "releases").has("trace_id")).toBe(true);
      expect(columns(q.sql, "prompt_runs").has("race_width")).toBe(true);
      // A new hive has no settings row yet (it gets one, autonomous, at its first v2 filing).
      expect(loadHiveSettings(q.sql)).toBeNull();
      // Idempotent: re-running is a no-op.
      expect(migrate(state.storage)).toBe(13);
      expect(Number(q.sql.exec("SELECT COUNT(*) AS n FROM _migrations").one().n)).toBe(13);
    });
  });

  it("a v7 hive with 3 prompts, audit rows and a release migrates to v11 with its v1 snapshot unchanged", async () => {
    const hive = newHive();
    await runInDurableObject(stubFor(hive), (q: QueenNode, state) => {
      const sql = q.sql;
      resetToEmpty(sql);
      expect(migrate(state.storage, 7)).toBe(7);
      expect(tables(sql).has("work_items")).toBe(false);

      // ── v7 fixture ──
      const p = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
      const prompts: [string, string, string, number][] = [
        [p[0], "Add a dark theme\n\nto the status page at /", "MERGED", 0],
        [p[1], "Add a /health JSON endpoint", "FAILED", 2],
        [p[2], "  \nFix the footer year", "BUILDING", 1],
      ];
      prompts.forEach(([id, text, status, attempts], i) =>
        sql.exec(
          "INSERT INTO prompt_runs (prompt_id, namespace, prompt_text, status, created_at, seq, summary, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id, hive, text, status, 1000 + i, i + 1, i === 1 ? "smoke failed on /health" : null, attempts,
        ),
      );
      const trains: [string, string, string, string, string[]][] = [
        ["t1", p[0], "MERGED", "MERGED", [p[0]]],
        ["t2", p[1], "EJECTED", "EJECTED", [p[0], p[1]]],
        ["t3", p[2], "BUILDING", "BUILDING", [p[2]]],
      ];
      trains.forEach(([id, prompt, status, phase, included], i) =>
        sql.exec(
          `INSERT INTO merge_trains (train_id, base_sha, included_prompts, artifact_repo, status, created_at, seq, prompt_id, phase, fork_state, action,
             head_sha, landed_sha, model, memories)
           VALUES (?, 'base', ?, ?, ?, ?, ?, ?, ?, 'READY', 'BUILD', ?, ?, '@cf/m', '[]')`,
          id, JSON.stringify(included), `${hive}-train-${id}`, status, 2000 + i, i + 1, prompt, phase,
          i === 0 ? "a".repeat(40) : null, i === 0 ? "b".repeat(40) : null,
        ),
      );
      const note = JSON.stringify(GitNotesPayloadSchema.parse({ taskPrompt: "p", model: "m", temperature: 0, reasoningSteps: ["r"], result: "success", executionTimeMs: 5 }));
      const audits: [string, string, string, string, string | null, number][] = [
        ["a1", p[0], "BUILDER", "PASSED", note, 3000],
        ["a2", p[0], "LANDER", "PASSED", null, 3001],
        ["a3", p[1], "GATEKEEPER", "REJECTED", null, 3001], // same ms as a2: rowid breaks the tie
        ["a4", p[2], "BUILDER", "RUNNING", null, 3002],
      ];
      for (const a of audits) {
        sql.exec("INSERT INTO audit_trail (event_id, prompt_id, drone_role, status, git_notes_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)", ...a);
      }
      const releaseId = crypto.randomUUID();
      sql.exec(
        `INSERT INTO releases (release_id, hive, head_sha, train_ids, phase, created_at, updated_at, seq, tapped_by)
         VALUES (?, ?, ?, ?, 'AWAITING_TAP', 4000, 4000, 1, NULL)`,
        releaseId, hive, "b".repeat(40), JSON.stringify(["t1"]),
      );

      // What a v1 consumer saw at v7 (the v1 snapshot queries).
      const before = {
        promptRuns: sql.exec("SELECT * FROM prompt_runs ORDER BY seq").toArray().map(rowToPrompt).map(toPromptRun),
        trains: sql.exec("SELECT * FROM merge_trains ORDER BY seq").toArray().map(rowToTrain).map(toMergeTrain),
        recentAudit: sql.exec("SELECT * FROM audit_trail ORDER BY created_at DESC, rowid DESC").toArray().map(rowToAudit).reverse(),
        releases: sql.exec("SELECT * FROM releases ORDER BY seq").toArray().map(rowToRelease).map(toRelease),
      };

      // ── migrate ──
      expect(migrate(state.storage)).toBe(13);
      expect(version(sql)).toBe(13);

      // 3 work_items: user feature items with the prompt ids, v2 trace ids and first-line titles.
      const items = sql.exec("SELECT * FROM work_items ORDER BY seq").toArray().map(rowToWorkItem);
      expect(items.map((i) => [i.itemId, i.status, i.kind, i.title, i.attempts])).toEqual([
        [p[0], "LANDED", "feature", "Add a dark theme", 0],
        [p[1], "FAILED", "feature", "Add a /health JSON endpoint", 2],
        [p[2], "ACTIVE", "feature", "Fix the footer year", 1],
      ]);
      for (const i of items) {
        expect(i).toMatchObject({ hive, rootId: i.itemId, parentId: null, depth: 0, priority: 2, source: { kind: "user", actor: "legacy" } });
        expect(i.traceId).toBe(traceIdFromUuid(i.itemId));
        expect(i.traceId).toBe(i.itemId.replace(/-/g, ""));
        expect(i.spanId).toBe(spanIdFor(i.itemId));
        expect(i).toMatchObject({ paths: [], conflicts: 0, waitReason: null, normalizedTitle: i.title.toLowerCase() });
      }

      // event_log has the audit rows, in order, as drone.audit events carrying the item's trace.
      const events = sql.exec("SELECT * FROM event_log ORDER BY seq").toArray();
      expect(events.map((e) => e.event_id)).toEqual(["a1", "a2", "a3", "a4"]);
      const parsed = events.map(rowToEvent);
      expect(parsed.every((e) => e.type === "drone.audit" && e.hive === hive && e.severity === "info")).toBe(true);
      expect(parsed[0]).toMatchObject({ actor: "drone:BUILDER", itemId: p[0], traceId: traceIdFromUuid(p[0]), summary: "BUILDER PASSED", droneRole: "BUILDER", auditStatus: "PASSED" });
      expect(parsed[0]!.gitNotesPayload).toEqual(JSON.parse(note));
      expect(events.map(rowToAudit)).toEqual(before.recentAudit);

      // Existing hives are supervised (D2).
      expect(loadHiveSettings(sql)).toMatchObject({ hive, autonomy: "supervised", updatedBy: "migration-v10", rollbackStreak: 0, degradedBy: [], leasedSlots: 0, carInfraFailures: 0 });

      // Every train is lane BUILD and carries its item's trace; the release has its own trace.
      expect(sql.exec("SELECT train_id, lane, trace_id FROM merge_trains ORDER BY seq").toArray()).toEqual(
        trains.map(([id, prompt]) => ({ train_id: id, lane: "BUILD", trace_id: traceIdFromUuid(prompt) })),
      );
      expect(rowToRelease(sql.exec("SELECT * FROM releases").one()).traceId).toBe(traceIdFromUuid(releaseId));

      // WP2.1 (deliberate): the snapshot moved to the v2 shape (toMergeTrainV2 plus the
      // optional v2 keys). Every v1 key and value is unchanged, so v1 consumers still parse it;
      // trains only gain the v2 fields that are set (here: the migrated trace id).
      const snap = q.getSnapshot();
      expect(QueenServerMessageSchema.safeParse(snap).success).toBe(true);
      expect(Object.keys(snap)).toEqual(expect.arrayContaining(["deployments", "modelStats", "promptRuns", "recentAudit", "releases", "routerFloor", "trains", "type", "verdicts"]));
      expect(snap.promptRuns).toEqual(before.promptRuns);
      expect(snap.trains).toEqual(before.trains.map((t, i) => ({ ...t, traceId: traceIdFromUuid(trains[i]![1]) })));
      expect(snap.recentAudit).toEqual(before.recentAudit);
      expect(snap.releases).toEqual(before.releases);
    });
  });

  it("appendAudit writes event_log (and audit_trail) and the snapshot reads it", async () => {
    const hive = newHive();
    const stub = stubFor(hive);
    const res = await stub.submitPrompt({ namespace: hive, promptText: "Add a /health endpoint" });
    const event = await stub.appendAudit({ promptId: res.promptId, droneRole: "BUILDER", status: "RUNNING" });
    await runInDurableObject(stub, (q: QueenNode) => {
      expect(q.sql.exec("SELECT COUNT(*) AS n FROM audit_trail").one().n).toBe(1);
      const row = q.sql.exec("SELECT * FROM event_log WHERE event_id = ?", event.eventId).one();
      expect(rowToEvent(row)).toMatchObject({ type: "drone.audit", hive, itemId: res.promptId, traceId: traceIdFromUuid(res.promptId), auditStatus: "RUNNING" });
      expect(q.getSnapshot().recentAudit).toEqual([event]);
    });
  });
});

describe("v2 row mappers round-trip", () => {
  it("work items, races, settings, escalations, events, metrics, claims and v2 train columns", async () => {
    const hive = newHive();
    await runInDurableObject(stubFor(hive), (q: QueenNode) => {
      const sql = q.sql;
      const itemId = crypto.randomUUID();
      const item: WorkItemRecord = {
        itemId,
        hive,
        kind: "feature",
        title: "Dark mode",
        body: "b",
        acceptance: ["visible at /"],
        priority: 1,
        status: "READY",
        parentId: null,
        rootId: itemId,
        depth: 0,
        dependsOn: ["x"],
        source: { kind: "oracle", actor: "oracle", itemId: "g1", commandId: "g1-decompose-1" },
        traceId: traceIdFromUuid(itemId),
        spanId: spanIdFor(itemId),
        difficulty: "hard",
        bestOf: 3,
        attempts: 1,
        conflicts: 1,
        paths: ["src/lib/theme.js", "src/features/"],
        waitReason: "affinity: src/lib/theme.js held by y",
        duplicateOf: null,
        blockedReason: null,
        releaseId: null,
        escalationId: null,
        createdAt: 1,
        updatedAt: 2,
        seq: 7,
        commandId: null,
        commandIssuedAt: null,
        normalizedTitle: "dark mode",
        landedAt: null,
        shippedAt: null,
      };
      upsertWorkItem(sql, item);
      expect(rowToWorkItem(sql.exec("SELECT * FROM work_items WHERE item_id = ?", itemId).one())).toEqual(item);
      upsertWorkItem(sql, { ...item, status: "ACTIVE", updatedAt: 3, seq: 99, traceId: "f".repeat(32) });
      // Identity columns (seq, trace) never change on update.
      expect(rowToWorkItem(sql.exec("SELECT * FROM work_items WHERE item_id = ?", itemId).one())).toEqual({ ...item, status: "ACTIVE", updatedAt: 3 });

      const race = { raceId: "r1", itemId, width: 3, state: "RACING" as const, trainIds: ["a", "b", "c"], winnerTrainId: null, reason: null, deadlineAt: 9, createdAt: 1, decidedAt: null };
      upsertRace(sql, race);
      upsertRace(sql, { ...race, state: "DECIDED", winnerTrainId: "b", reason: "won", decidedAt: 10 });
      expect(rowToRace(sql.exec("SELECT * FROM races").one())).toEqual({ ...race, state: "DECIDED", winnerTrainId: "b", reason: "won", decidedAt: 10 });

      const settings = {
        hive,
        autonomy: "autonomous" as const,
        overrides: { guardrails: { maxQueueBatch: 1 }, budget: { dailyCredits: 10 } },
        budgetDay: "2026-10-05",
        creditsUsed: 1.5,
        dispatches: 2,
        autoFiledHour: 5,
        autoFiledCount: 1,
        rollbackStreak: 1,
        degradedBy: ["ERROR_BUDGET_EXHAUSTED" as const],
        updatedBy: "user:k",
        updatedAt: 4,
        leasedSlots: 24,
        leaseExpiresAt: 99,
        carInfraFailures: 2,
      };
      upsertHiveSettings(sql, settings);
      expect(loadHiveSettings(sql)).toEqual(settings);
      expect(loadHiveSettings(sql)).not.toHaveProperty("budgetBoost");
      const boosted = { ...settings, budgetBoost: { day: "2026-10-05", dailyCredits: 75_000, dailyDispatches: 600 } };
      upsertHiveSettings(sql, boosted);
      expect(loadHiveSettings(sql)).toEqual(boosted);
      upsertHiveSettings(sql, settings);
      expect(loadHiveSettings(sql)).toEqual(settings);

      const esc = {
        escalationId: "e1",
        hive,
        reason: "APPROVAL_REQUIRED" as const,
        status: "OPEN" as const,
        subject: { type: "release" as const, id: "rel" },
        traceId: null,
        summary: "s",
        actions: ["ship" as const, "hold" as const],
        createdAt: 1,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
      };
      upsertEscalation(sql, esc);
      expect(sql.exec(ESCALATION_SELECT).toArray().map(rowToEscalation)).toEqual([esc]);

      const ev = {
        eventId: "ev1",
        ts: 5,
        hive,
        type: "queue.conflict" as const,
        severity: "warn" as const,
        actor: "queen",
        traceId: item.traceId,
        spanId: spanIdFor("t1"),
        parentSpanId: item.spanId,
        itemId,
        trainId: "t1",
        releaseId: null,
        commandId: null,
        summary: "conflict on src/lib/format.js",
        data: { paths: ["src/lib/format.js"] },
      };
      const seq = insertEvent(sql, ev);
      expect(seq).toBeGreaterThan(0);
      expect(insertEvent(sql, ev)).toBeNull();
      expect(rowToEvent(sql.exec("SELECT * FROM event_log WHERE seq = ?", seq).one())).toEqual({ ...ev, seq });

      upsertMetric(sql, { bucket: 3_600_000, name: "builds", labels: { role: "builder", model: "m" }, count: 1, sum: 40, min: 40, max: 40 });
      upsertMetric(sql, { bucket: 3_600_000, name: "builds", labels: { model: "m", role: "builder" }, count: 1, sum: 10, min: 10, max: 10 });
      expect(sql.exec("SELECT * FROM metrics_hourly").toArray().map(rowToMetric)).toEqual([
        { bucket: 3_600_000, name: "builds", labels: { model: "m", role: "builder" }, count: 2, sum: 50, min: 10, max: 40 },
      ]);
      expect(canonicalLabels({ b: "1", a: "2" })).toBe('{"a":"2","b":"1"}');

      upsertClaim(sql, { path: "src/lib/theme.js", itemId, source: "predicted", createdAt: 1 });
      upsertClaim(sql, { path: "src/lib/theme.js", itemId, source: "actual", createdAt: 2 });
      upsertClaim(sql, { path: "src/x.js", itemId: "other", source: "conflict", createdAt: 3 });
      expect(sql.exec("SELECT * FROM path_claims ORDER BY path").toArray().map(rowToClaim)).toEqual([
        { path: "src/lib/theme.js", itemId, source: "actual", createdAt: 1 },
        { path: "src/x.js", itemId: "other", source: "conflict", createdAt: 3 },
      ]);
      deleteClaims(sql, itemId);
      expect(sql.exec("SELECT COUNT(*) AS n FROM path_claims").one().n).toBe(1);

      // merge_trains: v2 columns round-trip; v1 rows read back as lane BUILD.
      sql.exec("INSERT INTO prompt_runs (prompt_id, namespace, prompt_text, status, created_at, seq, attempts) VALUES (?, ?, 'x', 'IN_TRAIN', 1, 1, 0)", itemId, hive);
      const car = {
        ...rowToTrain({
          train_id: "car1", base_sha: "b", included_prompts: JSON.stringify([itemId]), artifact_repo: `${hive}-train-car1`, status: "BUILDING",
          created_at: 1, seq: 1, prompt_id: itemId, phase: "WAITING_PARENT", fork_state: "NONE", action: "BUILD", dispatched: 0,
          fork_source: null, head_sha: null, landed_sha: null, summary: null, reason: null, fork_command_id: null, delete_command_id: null,
          deploy_state: "NONE", deploy_command_id: null, teardown_command_id: null, preview_url: null, fork_issued_at: null, delete_issued_at: null,
          deploy_issued_at: null, teardown_issued_at: null, drone_issued_at: null, drone_attempt: 1, model: null, model_reason: null,
          model_choice: null, model_choice_attempt: null, model_outcome: null, model_probe: 0, memories: null,
        }),
        traceId: item.traceId,
        raceId: "r1",
        candidate: 2,
        raceOutcome: "WON" as const,
        score: { review: "approved" as const, satisfied: 3, missing: 0, changedFiles: 2, changedBytes: 99, checks: 4 },
        credits: 1.25,
        lane: "QUEUE" as const,
        members: ["t1", "t2"],
        carId: null,
        passedSeq: 3,
        passedAt: 1234,
        conflict: { trainId: "t2", kind: "content" as const, paths: ["a.js"], summary: "s" },
        changedPaths: ["a.js"],
        waitForCarSeq: 4,
        bisectOf: "car0",
        verified: true,
      };
      upsertTrain(sql, car);
      expect(rowToTrain(sql.exec("SELECT * FROM merge_trains WHERE train_id = 'car1'").one())).toEqual(car);
      upsertTrain(sql, { ...car, verified: false });
      expect(rowToTrain(sql.exec("SELECT * FROM merge_trains WHERE train_id = 'car1'").one()).verified).toBe(false);
      upsertTrain(sql, { ...car, verified: null });
      expect(rowToTrain(sql.exec("SELECT * FROM merge_trains WHERE train_id = 'car1'").one())).not.toHaveProperty("verified");
      upsertTrain(sql, car);

      // prompt_runs: race_width and difficulty (v8 columns) round-trip.
      const prompt = rowToPrompt(sql.exec("SELECT * FROM prompt_runs WHERE prompt_id = ?", itemId).one());
      expect(prompt).toMatchObject({ raceWidth: 1, difficulty: "normal" });
      upsertPrompt(sql, { ...prompt, raceWidth: 3, difficulty: "hard" });
      expect(rowToPrompt(sql.exec("SELECT * FROM prompt_runs WHERE prompt_id = ?", itemId).one())).toMatchObject({ raceWidth: 3, difficulty: "hard" });
      upsertTrain(sql, { ...car, trainId: "t9", lane: undefined, members: undefined, changedPaths: undefined, score: null, conflict: null });
      const plain = rowToTrain(sql.exec("SELECT * FROM merge_trains WHERE train_id = 't9'").one());
      expect(plain.lane).toBe("BUILD");
      expect("members" in plain).toBe(false);
      expect(toMergeTrain(plain)).not.toHaveProperty("lane");

      // The audit helpers agree with each other.
      const audit: AuditEvent = { eventId: "au1", promptId: itemId, droneRole: "SCRIBE", status: "PASSED", gitNotesPayload: null, createdAt: 9 };
      appendAuditRow(sql, audit, hive);
      expect(listRecentAudit(sql, 50)).toEqual([audit]);
      expect(rowToAudit(sql.exec("SELECT * FROM audit_trail WHERE event_id = 'au1'").one())).toEqual(audit);
      // The audit event carries the item's (not a minted) trace.
      expect(rowToEvent(sql.exec("SELECT * FROM event_log WHERE event_id = 'au1'").one()).traceId).toBe(item.traceId);
    });
  });
});
