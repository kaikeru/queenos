/** Submission origin badges (docs/human-push-design.md §2): whose code a train carries. Pure; unit-tested. */
import type { MergeTrain, SubmissionOrigin, SubmissionOriginKind, WorkItem } from "@queenos/queen-types";

export interface OriginBadge {
  kind: SubmissionOriginKind;
  /** Short label: "drone", "human:kyle@kaikeru.com", "agent:claude-code". */
  text: string;
  /** Tooltip: the full origin id. */
  title: string;
  /** Agent origins: the model the token's minter claimed (self-reported, unverified); else null. */
  claim: string | null;
}

/** A train's origin; absent / null means drone code (the Queen's contract). */
export function originOf(t: Pick<MergeTrain, "origin"> | null | undefined): SubmissionOrigin {
  return t?.origin ?? { kind: "drone", id: "" };
}

export function originBadge(o: SubmissionOrigin | null | undefined): OriginBadge {
  if (!o || o.kind === "drone") return { kind: "drone", text: "drone", title: o?.id ? `drone code (${o.id})` : "drone code", claim: null };
  if (o.kind === "human") return { kind: "human", text: `human:${o.id}`, title: `pushed by ${o.id}`, claim: null };
  // agent ids are "<name>@<owner email>": show the name, keep the owner in the tooltip.
  const at = o.id.indexOf("@");
  const name = at > 0 ? o.id.slice(0, at) : o.id;
  const owner = at > 0 ? o.id.slice(at + 1) : null;
  const claim = o.model ?? null;
  const who = owner ? `pushed by agent ${name} for ${owner}` : `pushed by agent ${name}`;
  return { kind: "agent", text: `agent:${name}`, title: claim ? `${who}; claims ${claim} (self-reported)` : who, claim };
}

/** Non-drone code only (dense views badge the exception, not the rule). */
export const isPushed = (t: Pick<MergeTrain, "origin"> | null | undefined): boolean => originOf(t).kind !== "drone";

/**
 * An item's origin: the newest train carrying pushed (human / agent) code, else an inbox item's pusher handle,
 * else drone. Items carry no origin of their own; their trains do.
 */
export function itemOrigin(item: Pick<WorkItem, "inbox"> | null, trains: readonly Pick<MergeTrain, "origin" | "createdAt">[]): OriginBadge {
  let newest: Pick<MergeTrain, "origin" | "createdAt"> | null = null;
  for (const t of trains) if (isPushed(t) && (!newest || t.createdAt >= newest.createdAt)) newest = t;
  if (newest) return originBadge(newest.origin);
  if (item?.inbox) return { kind: "human", text: `push:${item.inbox.handle}`, title: `pushed to ${item.inbox.ref.replace(/^refs\/heads\//, "")}`, claim: null };
  return originBadge(null);
}

// Pushed BUILD trains by item, cached per `trains` record (the reducer replaces it on every change).
const pushedCache = new WeakMap<object, Map<string, MergeTrain[]>>();

/** Item rows: the badge for pushed (human / agent / inbox) code, or null for drone-only items. */
export function pushedItemOrigin(
  state: { trains: Record<string, MergeTrain>; trainOrder: string[] },
  item: Pick<WorkItem, "itemId" | "inbox">,
  itemIdOf: (t: MergeTrain) => string | undefined,
): OriginBadge | null {
  let byItem = pushedCache.get(state.trains);
  if (!byItem) {
    byItem = new Map();
    for (const id of state.trainOrder) {
      const t = state.trains[id];
      if (!t || t.lane === "QUEUE" || !isPushed(t)) continue;
      const itemId = itemIdOf(t);
      if (itemId) byItem.set(itemId, [...(byItem.get(itemId) ?? []), t]);
    }
    pushedCache.set(state.trains, byItem);
  }
  const b = itemOrigin(item, byItem.get(item.itemId) ?? []);
  return b.kind === "drone" ? null : b;
}
