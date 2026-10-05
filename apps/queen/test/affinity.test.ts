import { describe, expect, it } from "vitest";
import { affinityWaitReason, blockingClaim, claimsFor, release, widen, type PathClaim } from "../src/work/affinity";

const claim = (path: string, itemId: string, source: PathClaim["source"] = "predicted", createdAt = 1): PathClaim => ({
  path,
  itemId,
  source,
  createdAt,
});

describe("claimsFor", () => {
  it("claims every path as predicted, excluding generated paths and duplicates", () => {
    expect(claimsFor({ itemId: "a", paths: ["src/x.js", "src/features/index.js", "src/x.js", "lib/"] }, 7)).toEqual([
      claim("src/x.js", "a", "predicted", 7),
      claim("lib/", "a", "predicted", 7),
    ]);
  });
  it("claims nothing for empty paths", () => {
    expect(claimsFor({ itemId: "a", paths: [] }, 7)).toEqual([]);
  });
});

describe("blockingClaim", () => {
  const active = new Set(["h1", "h2"]);
  const table: { name: string; paths: string[]; claims: PathClaim[]; want: { path: string; holder: string } | null }[] = [
    { name: "equal path", paths: ["src/theme.js"], claims: [claim("src/theme.js", "h1")], want: { path: "src/theme.js", holder: "h1" } },
    { name: "my dir covers a held file", paths: ["src/lib/"], claims: [claim("src/lib/a.js", "h1")], want: { path: "src/lib/", holder: "h1" } },
    { name: "a held dir covers my file", paths: ["src/lib/a.js"], claims: [claim("src/lib/", "h2")], want: { path: "src/lib/a.js", holder: "h2" } },
    { name: "sibling prefix is not overlap", paths: ["src/a"], claims: [claim("src/ab", "h1")], want: null },
    { name: "empty paths never wait", paths: [], claims: [claim("src/a.js", "h1")], want: null },
    { name: "generated paths never wait", paths: ["src/features/index.js"], claims: [claim("src/features/index.js", "h1")], want: null },
    { name: "claims of non-active items never block", paths: ["src/a.js"], claims: [claim("src/a.js", "gone")], want: null },
    { name: "own claims never block", paths: ["src/a.js"], claims: [claim("src/a.js", "me")], want: null },
    {
      name: "first overlapping path in the item's order wins",
      paths: ["src/b.js", "src/a.js"],
      claims: [claim("src/a.js", "h1"), claim("src/b.js", "h2")],
      want: { path: "src/b.js", holder: "h2" },
    },
  ];
  for (const t of table) {
    it(t.name, () => {
      expect(blockingClaim({ itemId: "me", paths: t.paths }, t.claims, new Set([...active, "me"]))).toEqual(t.want);
    });
  }
  it("formats the wait reason", () => {
    expect(affinityWaitReason({ path: "src/theme.js", holder: "G-c1" })).toBe("affinity: src/theme.js held by G-c1");
  });
});

describe("widen", () => {
  const existing = [claim("src/a.js", "i", "predicted", 1), claim("src/b.js", "i", "actual", 1), claim("src/c.js", "i", "conflict", 1)];
  it("adds new paths, upgrades predicted, skips equal or stronger sources and generated paths", () => {
    expect(widen("i", ["src/a.js", "src/b.js", "src/c.js", "src/d.js", "src/features/index.js"], "actual", existing, 9)).toEqual([
      claim("src/a.js", "i", "actual", 1),
      claim("src/d.js", "i", "actual", 9),
    ]);
  });
  it("a conflict widens claims, upgrading actual ones", () => {
    expect(widen("i", ["src/b.js", "src/e.js"], "conflict", existing, 9)).toEqual([
      claim("src/b.js", "i", "conflict", 1),
      claim("src/e.js", "i", "conflict", 9),
    ]);
  });
  it("another item's claim on the same path does not count", () => {
    expect(widen("j", ["src/a.js"], "actual", existing, 9)).toEqual([claim("src/a.js", "j", "actual", 9)]);
  });
});

describe("release", () => {
  it("returns only the item's claims", () => {
    const all = [claim("a", "i"), claim("b", "j"), claim("c", "i")];
    expect(release("i", all)).toEqual([claim("a", "i"), claim("c", "i")]);
  });
});
