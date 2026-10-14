/** Pure client-side route matching (no React, no DOM; unit-tested). */

/** Hive-scoped pages (v2 design §5). */
export type HivePage = "status" | "queue" | "item" | "trace" | "events" | "metrics" | "push";

export type Route =
  | { name: "home" }
  | { name: "new" }
  | { name: "setup"; hive: string }
  /**
   * Every hive-scoped page. `page` picks the view: `/p/:hive` is the status home ("status"), `/p/:hive/items/:id` the
   * goal page ("item"). `id` is the item id or trace id for "item" and "trace". `redirectTo`: the removed lanes page
   * (`/p/:hive/lanes`) renders home and App replaces the URL with it.
   */
  | { name: "warroom"; hive: string; page: HivePage; id?: string; legacy?: boolean; redirectTo?: string }
  | { name: "notfound"; path: string };

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TRACE_ID = /^[0-9a-f]{32}$/;

function seg(raw: string): string | null {
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return SEGMENT.test(s) ? s : null;
}

const SIMPLE_PAGES: Record<string, HivePage> = { queue: "queue", events: "events", metrics: "metrics", push: "push" };

/**
 * Match a location to a route. `/?hive=x` keeps working (it maps to the status
 * home) so existing bookmarks and the sim scripts do not break.
 */
export function matchRoute(pathname: string, search = ""): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) {
    const legacy = new URLSearchParams(search).get("hive");
    const hive = legacy ? seg(legacy) : null;
    return hive ? { name: "warroom", hive, page: "status", legacy: true } : { name: "home" };
  }
  if (parts.length === 1 && parts[0] === "new") return { name: "new" };
  if (parts[0] === "p" && parts.length >= 2 && parts.length <= 4) {
    const hive = seg(parts[1]!);
    if (hive) {
      if (parts.length === 2) return { name: "warroom", hive, page: "status" };
      const sub = parts[2]!;
      if (parts.length === 3) {
        if (sub === "setup") return { name: "setup", hive };
        if (sub === "lanes") return { name: "warroom", hive, page: "status", redirectTo: hv(hive) };
        const page = SIMPLE_PAGES[sub];
        if (page) return { name: "warroom", hive, page };
      } else if (sub === "items") {
        const id = seg(parts[3]!);
        if (id) return { name: "warroom", hive, page: "item", id };
      } else if (sub === "traces") {
        const id = parts[3]!.toLowerCase();
        if (TRACE_ID.test(id)) return { name: "warroom", hive, page: "trace", id };
      }
    }
  }
  return { name: "notfound", path: pathname };
}

const hv = (hive: string) => `/p/${encodeURIComponent(hive)}`;

export const hrefFor = {
  home: () => "/",
  new: () => "/new",
  setup: (hive: string) => `${hv(hive)}/setup`,
  /** The hive's landing page: the status home. */
  warroom: (hive: string) => hv(hive),
  status: (hive: string) => hv(hive),
  queue: (hive: string) => `${hv(hive)}/queue`,
  item: (hive: string, itemId: string) => `${hv(hive)}/items/${encodeURIComponent(itemId)}`,
  trace: (hive: string, traceId: string) => `${hv(hive)}/traces/${encodeURIComponent(traceId)}`,
  events: (hive: string) => `${hv(hive)}/events`,
  metrics: (hive: string) => `${hv(hive)}/metrics`,
  /** Git tokens and clone / push instructions. */
  push: (hive: string) => `${hv(hive)}/push`,
};
