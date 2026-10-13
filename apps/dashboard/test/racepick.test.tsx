/** T9d: the Pick view, its countdown / 409 / composer-judge logic, and the pick API call. */
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MergeTrain, Race, WorkItem } from "@queenos/queen-types";

import { api, ApiError, pickBody } from "../src/api";
import { RaceEntries } from "../src/RaceEntries";
import { RacePick } from "../src/RacePick";
import { closeEntriesFailure, composerRace, pickHint, countdownLine, countdownText, decidedSummary, entriesLine, entryState, pickCards, pickFailure, pickRemainingMs } from "../src/raceLogic";
import { raceView, raceViewForItem, swarmTiles } from "../src/swarm";

const NOW = 1_800_000_000_000;
const race = (over: Partial<Race> = {}): Race => ({
  raceId: "r1", itemId: "i1", width: 3, state: "PICKING", trainIds: ["a", "b", "c"], winnerTrainId: null, reason: null, deadlineAt: null,
  createdAt: NOW - 60_000, decidedAt: null, pickDeadlineAt: NOW + 723_000, recommendedTrainId: "b", recommendReason: "b: smallest diff", ...over,
});
const score = { review: "approved" as const, satisfied: 3, missing: 1, changedFiles: 2, changedBytes: 2048, checks: 4 };
const train = (id: string, i: number, over: Partial<MergeTrain> = {}): MergeTrain =>
  ({ trainId: id, baseSha: "0", includedPrompts: ["i1"], artifactRepo: "r", status: "TESTING", phase: "TESTING", lane: "BUILD", createdAt: NOW, raceId: "r1", candidate: i,
    raceOutcome: "PASSED", model: `model-${id}`, previewUrl: `https://${id}.example.dev`, summary: `notes ${id}`, score, ...over }) as MergeTrain;
const item = { itemId: "i1", title: "Pricing page", judge: "human" } as WorkItem;

function state(r: Race, trains: MergeTrain[]) {
  return { trains: Object.fromEntries(trains.map((t) => [t.trainId, t])), trainOrder: trains.map((t) => t.trainId), items: { i1: item }, races: { r1: r }, events: [], landed: [] } as unknown as Parameters<typeof raceView>[0];
}
const three = () => [train("a", 0), train("b", 1, { score: { ...score, changedBytes: 1024 } }), train("c", 2, { score: undefined, previewUrl: null })];

describe("countdown", () => {
  test("mm:ss, h:mm:ss, clamps at zero", () => {
    expect(countdownText(723_000)).toBe("12:03");
    expect(countdownText(5_000)).toBe("0:05");
    expect(countdownText(3_725_000)).toBe("1:02:05");
    expect(countdownText(-10)).toBe("0:00");
  });
  test("only a PICKING race with a deadline counts down", () => {
    expect(pickRemainingMs(race(), NOW)).toBe(723_000);
    expect(pickRemainingMs(race({ pickDeadlineAt: undefined }), NOW)).toBeNull();
    expect(pickRemainingMs(race({ state: "DECIDED" }), NOW)).toBeNull();
    expect(pickRemainingMs(race({ pickDeadlineAt: NOW - 5 }), NOW)).toBe(0);
  });
  test("names the recommended candidate", () => {
    const v = raceView(state(race(), three()), "r1", NOW)!;
    expect(countdownLine(v, NOW)).toBe("auto-picks model-b in 12:03");
    expect(countdownLine(v, NOW + 800_000)).toBe("auto-picking model-b now");
  });
});

describe("cards", () => {
  test("derives diff, gate, reviewer, preview and falls back to n/a", () => {
    const cards = pickCards(raceView(state(race(), three()), "r1", NOW)!);
    expect(cards.map((c) => c.trainId)).toEqual(["a", "b", "c"]);
    expect(cards[1]).toMatchObject({ recommended: true, pickable: true, changedBytes: 1024, satisfied: 3, missing: 1, previewUrl: "https://b.example.dev" });
    expect(cards[2]).toMatchObject({ changedBytes: null, checks: null, previewUrl: null });
  });
  test("failed / lost candidates are not shown while picking; rejected ones are, unpickable", () => {
    const ts = [...three(), train("d", 3, { raceOutcome: "FAILED", status: "EJECTED" })];
    const r = race({ rejections: [{ trainId: "a", by: "human:x@y.z", reason: "ugly" }] });
    const cards = pickCards(raceView(state(r, ts), "r1", NOW)!);
    expect(cards.map((c) => c.trainId)).toEqual(["a", "b", "c"]);
    expect(cards[0]).toMatchObject({ pickable: false, rejectedReason: "ugly" });
  });
  test("a non-http preview URL is never linked", () => {
    const c = pickCards(raceView(state(race(), [train("a", 0, { previewUrl: "javascript:alert(1)" })]), "r1", NOW)!)[0]!;
    expect(c.previewUrl).toBeNull();
  });
});

describe("decided result", () => {
  test("human pick against the recommendation", () => {
    const d = decidedSummary(race({ state: "DECIDED", winnerTrainId: "a", decidedBy: "human:k@kaikeru.com" }))!;
    expect(d).toMatchObject({ human: true, agreed: false, text: "picked by k@kaikeru.com" });
  });
  test("deadline fallback agrees with the recommendation", () => {
    expect(decidedSummary(race({ state: "DECIDED", winnerTrainId: "b", decidedBy: "queen:deadline" }))).toMatchObject({ human: false, agreed: true });
  });
  test("not decided, or an older Queen without decidedBy", () => {
    expect(decidedSummary(race())).toBeNull();
    expect(decidedSummary(race({ state: "DECIDED", recommendedTrainId: undefined }))).toMatchObject({ by: null, agreed: null });
  });
});

describe("409 handling and the API call", () => {
  test("409 is a friendly refresh, other errors pass through", () => {
    const f = pickFailure(new ApiError("race is not PICKING", 409));
    expect(f.refresh).toBe(true);
    expect(f.message).toContain("no longer open for picking");
    expect(f.message).not.toContain("PICKING");
    expect(pickFailure(new ApiError("boom", 500))).toEqual({ message: "boom", refresh: false });
  });
  test("body omits a blank reason and clips a long one", () => {
    expect(pickBody("t1", "  ")).toEqual({ trainId: "t1" });
    expect(pickBody("t1", " cleaner ")).toEqual({ trainId: "t1", reason: "cleaner" });
    expect(pickBody("t1", "x".repeat(400)).reason).toHaveLength(300);
  });
  afterEach(() => vi.unstubAllGlobals());
  test("pickRace POSTs {trainId, reason} to the pick route", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await api.pickRace("demo hive", "r/1", "t1", "nicer");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/hives/demo%20hive/races/r%2F1/pick");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ trainId: "t1", reason: "nicer" });
  });
  test("pickRace surfaces a 409 as ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not picking" }), { status: 409 })));
    await expect(api.pickRace("h", "r", "t")).rejects.toMatchObject({ status: 409 });
  });
});

describe("composer judge option", () => {
  test("you pick = best-of 3 with judge human; numbers and auto carry no judge", () => {
    expect(composerRace("pick")).toEqual({ bestOf: 3, judge: "human" });
    expect(composerRace("auto")).toEqual({});
    expect(composerRace("2")).toEqual({ bestOf: 2 });
  });
});

describe("render", () => {
  const view = (r: Race, ts = three()) => raceView(state(r, ts), "r1", NOW)!;
  test("PICKING: candidates, recommended badge and reason, countdown, pick buttons, preview link", () => {
    const html = renderToString(<RacePick hive="demo" view={view(race())} now={NOW} />);
    expect(html).toContain("YOUR PICK");
    expect(html).toContain("auto-picks model-b in 12:03");
    expect(html).toContain("smallest diff");
    expect(html).toContain("recommended");
    expect(html.match(/Pick this one/g)).toHaveLength(3);
    expect(html).toContain("https://a.example.dev");
    expect(html).toContain("<iframe");
    expect(html).toContain("3 satisfied");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("n/a");
  });
  test("DECIDED by a human: result shown, no pick buttons", () => {
    const html = renderToString(<RacePick hive="demo" view={view(race({ state: "DECIDED", winnerTrainId: "a", decidedBy: "human:k@kaikeru.com" }))} now={NOW} />);
    expect(html).toContain("picked by k@kaikeru.com");
    expect(html).toContain("overrode the Queen");
    expect(html).not.toContain("Pick this one");
    expect(html).not.toContain("<iframe");
  });
  test("a plain auto race renders nothing", () => {
    const v = raceView(state(race({ state: "DECIDED", winnerTrainId: "a", decidedBy: "queen:auto" }), three()), "r1", NOW)!;
    v.item = { ...item, judge: undefined } as WorkItem;
    expect(renderToString(<RacePick hive="demo" view={v} now={NOW} />)).toBe("");
  });
  test("raceViewForItem prefers a PICKING race over a newer decided one", () => {
    const s = state(race(), three());
    s.races = { r1: race(), r0: race({ raceId: "r0", state: "DECIDED", createdAt: NOW }) };
    expect(raceViewForItem(s, "i1", NOW)?.race.raceId).toBe("r1");
  });
});

describe("race entries (external hives)", () => {
  const racing = (over: Partial<Race> = {}) => race({ state: "RACING", pickDeadlineAt: undefined, recommendedTrainId: undefined, recommendReason: undefined, entryClosesAt: NOW + 723_000, ...over });
  const view = (r: Race, ts = three()) => raceView(state(r, ts), "r1", NOW)!;

  test("entryState: open while the window is in the future, closed after, null without a window or past RACING", () => {
    expect(entryState(racing(), NOW)).toEqual({ kind: "open", remainingMs: 723_000 });
    expect(entryState(racing({ entryClosesAt: NOW }), NOW)).toEqual({ kind: "closed" });
    expect(entryState(racing({ entryClosesAt: NOW - 1 }), NOW)).toEqual({ kind: "closed" });
    expect(entryState(racing({ entryClosesAt: null }), NOW)).toBeNull();
    expect(entryState(racing({ entryClosesAt: undefined }), NOW)).toBeNull();
    expect(entryState(racing({ state: "PICKING" }), NOW)).toBeNull();
    expect(entryState(racing({ state: "DECIDED" }), NOW)).toBeNull();
  });
  test("entriesLine formats the countdown and pluralises candidates", () => {
    expect(entriesLine(racing(), 2, NOW)).toBe("Entries open · closes in 12:03 (2 candidates)");
    expect(entriesLine(racing(), 1, NOW)).toBe("Entries open · closes in 12:03 (1 candidate)");
    expect(entriesLine(racing(), 0, NOW + 720_000)).toBe("Entries open · closes in 0:03 (0 candidates)");
    expect(entriesLine(racing({ entryClosesAt: NOW - 5 }), 2, NOW)).toBe("Entries closed · deciding…");
    expect(entriesLine(racing({ entryClosesAt: null }), 2, NOW)).toBeNull();
  });
  test("409 is a friendly refresh, other errors pass through", () => {
    expect(closeEntriesFailure(new ApiError("race is not RACING", 409))).toMatchObject({ refresh: true, message: expect.stringContaining("already closed") });
    expect(closeEntriesFailure(new ApiError("boom", 500))).toEqual({ message: "boom", refresh: false });
  });

  afterEach(() => vi.unstubAllGlobals());
  test("closeRaceEntries POSTs to the close-entries route", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await api.closeRaceEntries("demo hive", "r/1");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/hives/demo%20hive/races/r%2F1/close-entries");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });
  test("closeRaceEntries surfaces a 409 as ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "entries closed" }), { status: 409 })));
    await expect(api.closeRaceEntries("h", "r")).rejects.toMatchObject({ status: 409 });
  });

  test("open window: countdown, candidate count and the End entries now button", () => {
    const html = renderToString(<RaceEntries hive="demo" view={view(racing())} now={NOW} />);
    expect(html).toContain("Entries open · closes in 12:03 (3 candidates)");
    expect(html).toContain("End entries now");
    expect(html).not.toContain("disabled");
  });
  test("closed window: deciding message, no button", () => {
    const html = renderToString(<RaceEntries hive="demo" view={view(racing({ entryClosesAt: NOW - 1000 }))} now={NOW} />);
    expect(html).toContain("Entries closed · deciding…");
    expect(html).not.toContain("End entries now");
  });
  test("hidden for swarm races (no window) and non-RACING races", () => {
    expect(renderToString(<RaceEntries hive="demo" view={view(racing({ entryClosesAt: null }))} now={NOW} />)).toBe("");
    expect(renderToString(<RaceEntries hive="demo" view={view(racing({ state: "PICKING" }))} now={NOW} />)).toBe("");
    expect(renderToString(<RaceEntries hive="demo" view={view(racing({ state: "DECIDED" }))} now={NOW} />)).toBe("");
  });
});

describe("pick hint (human judge, race still RACING)", () => {
  const racing = (over: Partial<Race> = {}) => race({ state: "RACING", pickDeadlineAt: undefined, recommendedTrainId: undefined, recommendReason: undefined, entryClosesAt: NOW + 723_000, ...over });
  const v = (r: Race, judge: "human" | "auto" = "human") => {
    const view = raceView(state(r, three()), "r1", NOW)!;
    view.item = { ...item, judge: judge === "human" ? "human" : undefined } as WorkItem;
    return view;
  };
  const clock = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, "0")}:${String(new Date(ms).getMinutes()).padStart(2, "0")}`;

  test("explains when the pick buttons appear, with the closing time", () => {
    const hint = pickHint(v(racing()), NOW)!;
    expect(hint).toBe(`You pick the winner once entries close at ${clock(NOW + 723_000)} and two or more candidates pass. With one pass, the Queen takes it.`);
  });
  test("no clock time once the window has passed or when there is none", () => {
    expect(pickHint(v(racing({ entryClosesAt: NOW - 1 })), NOW)).toBe("You pick the winner once entries close and two or more candidates pass. With one pass, the Queen takes it.");
    expect(pickHint(v(racing({ entryClosesAt: undefined })), NOW)).toContain("once entries close and");
  });
  test("only for a RACING race with a human judge", () => {
    expect(pickHint(v(racing(), "auto"), NOW)).toBeNull();
    expect(pickHint(v(racing({ state: "PICKING" })), NOW)).toBeNull();
    expect(pickHint(v(racing({ state: "DECIDED" })), NOW)).toBeNull();
  });
  test("RacePick renders the hint (and no pick buttons) while RACING", () => {
    const html = renderToString(<RacePick hive="demo" view={v(racing())} now={NOW} />);
    expect(html).toContain("You pick the winner once entries close at");
    expect(html).not.toContain("Pick this one");
  });
  test("a RACING race with an auto judge still renders nothing", () => {
    expect(renderToString(<RacePick hive="demo" view={v(racing(), "auto")} now={NOW} />)).toBe("");
  });
});

describe("attempt id reaches the chips through the callers", () => {
  const att = (id: string, i: number, attemptId: string) => train(id, i, { origin: { kind: "agent", id: "opus@kyle@kaikeru.com" }, attemptId } as Partial<MergeTrain>);
  test("raceLogic pickCards forward attemptId to the origin badge", () => {
    const ts = [att("a", 0, "att_0123456789ab"), train("b", 1)];
    const cards = pickCards(raceView(state(race(), ts), "r1", NOW)!);
    expect(cards[0]!.origin).toMatchObject({ kind: "agent", attempt: "att_0123456789ab" });
    expect(cards[1]!.origin.attempt).toBeNull();
  });
  test("swarm tiles forward attemptId to the origin badge", () => {
    const ts = [att("a", 0, "att_0123456789ab")];
    const tile = swarmTiles(state(race({ state: "RACING" }), ts)).find((t) => t.trainId === "a");
    expect(tile?.origin).toMatchObject({ attempt: "att_0123456789ab" });
  });
});
