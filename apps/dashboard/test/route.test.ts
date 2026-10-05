import { expect, test } from "vitest";
import { hrefFor, matchRoute } from "../src/route";
import { projectHref } from "../src/Home";

test("matches the home, new, setup and war room routes", () => {
  expect(matchRoute("/")).toEqual({ name: "home" });
  expect(matchRoute("/new")).toEqual({ name: "new" });
  expect(matchRoute("/new/")).toEqual({ name: "new" });
  expect(matchRoute("/p/demo")).toEqual({ name: "warroom", hive: "demo", page: "status" });
  expect(matchRoute("/p/demo/")).toEqual({ name: "warroom", hive: "demo", page: "status" });
  expect(matchRoute("/p/pixel-pulse/setup")).toEqual({ name: "setup", hive: "pixel-pulse" });
});

test("keeps ?hive= working on / as a legacy War Room link", () => {
  expect(matchRoute("/", "?hive=sim1")).toEqual({ name: "warroom", hive: "sim1", page: "status", legacy: true });
  expect(matchRoute("/", "?hive=")).toEqual({ name: "home" });
  expect(matchRoute("/", "?hive=../x")).toEqual({ name: "home" });
});

test("rejects unknown or malformed paths", () => {
  expect(matchRoute("/nope").name).toBe("notfound");
  expect(matchRoute("/p").name).toBe("notfound");
  expect(matchRoute("/p/demo/other").name).toBe("notfound");
  expect(matchRoute("/p/demo/setup/x").name).toBe("notfound");
  expect(matchRoute("/p/%E0%A4%A/setup").name).toBe("notfound");
  expect(matchRoute("/p/-bad").name).toBe("notfound");
});

test("hrefFor round-trips through matchRoute", () => {
  expect(matchRoute(hrefFor.setup("my-hive"))).toEqual({ name: "setup", hive: "my-hive" });
  expect(matchRoute(hrefFor.warroom("my-hive"))).toEqual({ name: "warroom", hive: "my-hive", page: "status" });
});

test("project cards route by status", () => {
  expect(projectHref({ hive: "a", status: "ACTIVE" })).toBe("/p/a");
  expect(projectHref({ hive: "a", status: "ONBOARDING" })).toBe("/p/a/setup");
  expect(projectHref({ hive: "a", status: "FAILED" })).toBe("/p/a/setup");
});

const TRACE = "4e1f9a00112233445566778899aabbcc";

test("matches the v2 hive pages", () => {
  expect(matchRoute("/p/demo/lanes")).toEqual({ name: "warroom", hive: "demo", page: "lanes" });
  expect(matchRoute("/p/demo/queue")).toEqual({ name: "warroom", hive: "demo", page: "queue" });
  expect(matchRoute("/p/demo/events")).toEqual({ name: "warroom", hive: "demo", page: "events" });
  expect(matchRoute("/p/demo/metrics")).toEqual({ name: "warroom", hive: "demo", page: "metrics" });
  expect(matchRoute("/p/demo/items/g1-c3")).toEqual({ name: "warroom", hive: "demo", page: "item", id: "g1-c3" });
  expect(matchRoute(`/p/demo/traces/${TRACE}`)).toEqual({ name: "warroom", hive: "demo", page: "trace", id: TRACE });
});

test("rejects malformed v2 paths", () => {
  expect(matchRoute("/p/demo/items").name).toBe("notfound");
  expect(matchRoute("/p/demo/items/%E0%A4%A").name).toBe("notfound");
  expect(matchRoute("/p/demo/items/a/b").name).toBe("notfound");
  expect(matchRoute("/p/demo/traces/nothex").name).toBe("notfound");
  expect(matchRoute("/p/demo/queue/x").name).toBe("notfound");
});

test("hrefFor round-trips the v2 pages", () => {
  expect(matchRoute(hrefFor.lanes("h"))).toEqual({ name: "warroom", hive: "h", page: "lanes" });
  expect(matchRoute(hrefFor.queue("h"))).toEqual({ name: "warroom", hive: "h", page: "queue" });
  expect(matchRoute(hrefFor.events("h"))).toEqual({ name: "warroom", hive: "h", page: "events" });
  expect(matchRoute(hrefFor.metrics("h"))).toEqual({ name: "warroom", hive: "h", page: "metrics" });
  expect(matchRoute(hrefFor.item("h", "g1-c1"))).toEqual({ name: "warroom", hive: "h", page: "item", id: "g1-c1" });
  expect(matchRoute(hrefFor.trace("h", TRACE))).toEqual({ name: "warroom", hive: "h", page: "trace", id: TRACE });
  expect(hrefFor.status("h")).toBe(hrefFor.warroom("h"));
});
