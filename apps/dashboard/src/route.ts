/** Pure client-side route matching (no React, no DOM; unit-tested). */

export type Route =
  | { name: "home" }
  | { name: "new" }
  | { name: "setup"; hive: string }
  | { name: "warroom"; hive: string; legacy?: boolean }
  | { name: "notfound"; path: string };

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function seg(raw: string): string | null {
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return SEGMENT.test(s) ? s : null;
}

/**
 * Match a location to a route. `/?hive=x` keeps working as the War Room (sim
 * fallback) so existing bookmarks and the sim scripts do not break.
 */
export function matchRoute(pathname: string, search = ""): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    const legacy = new URLSearchParams(search).get("hive");
    const hive = legacy ? seg(legacy) : null;
    return hive ? { name: "warroom", hive, legacy: true } : { name: "home" };
  }
  if (parts.length === 1 && parts[0] === "new") return { name: "new" };
  if (parts[0] === "p" && parts.length >= 2 && parts.length <= 3) {
    const hive = seg(parts[1]!);
    if (hive) {
      if (parts.length === 2) return { name: "warroom", hive };
      if (parts[2] === "setup") return { name: "setup", hive };
    }
  }
  return { name: "notfound", path: pathname };
}

export const hrefFor = {
  home: () => "/",
  new: () => "/new",
  setup: (hive: string) => `/p/${encodeURIComponent(hive)}/setup`,
  warroom: (hive: string) => `/p/${encodeURIComponent(hive)}`,
};
