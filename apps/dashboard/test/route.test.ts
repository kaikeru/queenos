import { expect, test } from "vitest";
import { hrefFor, matchRoute } from "../src/route";
import { projectHref } from "../src/Home";

test("matches the home, new, setup and war room routes", () => {
  expect(matchRoute("/")).toEqual({ name: "home" });
  expect(matchRoute("/new")).toEqual({ name: "new" });
  expect(matchRoute("/new/")).toEqual({ name: "new" });
  expect(matchRoute("/p/demo")).toEqual({ name: "warroom", hive: "demo" });
  expect(matchRoute("/p/demo/")).toEqual({ name: "warroom", hive: "demo" });
  expect(matchRoute("/p/pixel-pulse/setup")).toEqual({ name: "setup", hive: "pixel-pulse" });
});

test("keeps ?hive= working on / as a legacy War Room link", () => {
  expect(matchRoute("/", "?hive=sim1")).toEqual({ name: "warroom", hive: "sim1", legacy: true });
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
  expect(matchRoute(hrefFor.warroom("my-hive"))).toEqual({ name: "warroom", hive: "my-hive" });
});

test("project cards route by status", () => {
  expect(projectHref({ hive: "a", status: "ACTIVE" })).toBe("/p/a");
  expect(projectHref({ hive: "a", status: "ONBOARDING" })).toBe("/p/a/setup");
  expect(projectHref({ hive: "a", status: "FAILED" })).toBe("/p/a/setup");
});
