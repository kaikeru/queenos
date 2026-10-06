/**
 * Release view logic (P3): timeline steps, the Sites rows and the tap-to-ship
 * button state. Pure; no React.
 */
import { AUTO_SHIP_ACTOR, CANARY_STEPS, type Release, type ReleasePhase, type SentinelVerdict } from "@queenos/queen-types";
import type { State } from "./reducer";

export const TERMINAL_PHASES: readonly ReleasePhase[] = ["SHIPPED", "FAILED", "ROLLED_BACK", "SUPERSEDED"];
export const isActive = (r: Release) => !TERMINAL_PHASES.includes(r.phase);

/** The release the War Room features: the newest one. */
export function currentRelease(state: Pick<State, "releases" | "releaseOrder">): Release | null {
  const id = state.releaseOrder[0];
  return id ? (state.releases[id] ?? null) : null;
}

// ── timeline ──────────────────────────────────────────────────────────────

export type StepState = "done" | "now" | "todo" | "bad" | "muted";

export interface TimelineStep {
  key: string;
  label: string;
  /** Canary steps carry their traffic percent. */
  percent?: number;
  state: StepState;
}

const BASE_STEPS = [
  { key: "STAGING", label: "STAGING" },
  { key: "VALIDATING", label: "VALIDATING" },
  { key: "AWAITING_TAP", label: "AWAITING TAP" },
  ...CANARY_STEPS.map((p) => ({ key: `CANARY_${p}`, label: `CANARY ${p}%`, percent: p })),
  { key: "SHIPPED", label: "SHIPPED" },
] as const;

/** Index into BASE_STEPS of where the release is (SHIPPED = past the end). */
function positionOf(r: Release, peak: number): number {
  switch (r.phase) {
    case "STAGING":
      return 0;
    case "VALIDATING":
      return 1;
    case "AWAITING_TAP":
      return 2;
    case "CANARY":
    case "ROLLED_BACK": {
      const pct = r.phase === "CANARY" ? (r.canaryPercent ?? 0) : Math.max(peak, r.canaryPercent ?? 0);
      const i = CANARY_STEPS.findIndex((s) => s >= pct && pct > 0);
      return 3 + (i < 0 ? 0 : i);
    }
    case "SHIPPED":
      return BASE_STEPS.length;
    case "FAILED":
      return r.stagingUrl ? 1 : 0;
    case "SUPERSEDED":
      return -1;
  }
}

export function timelineSteps(r: Release, peak = 0): TimelineStep[] {
  const pos = positionOf(r, peak);
  const failed = r.phase === "FAILED" || r.phase === "ROLLED_BACK";
  return BASE_STEPS.map((s, i): TimelineStep => {
    const step = { key: s.key, label: s.label, ...("percent" in s ? { percent: s.percent } : {}) };
    if (r.phase === "SUPERSEDED") return { ...step, state: "muted" };
    if (i < pos) return { ...step, state: "done" };
    if (i === pos) return { ...step, state: failed ? "bad" : "now" };
    return { ...step, state: "todo" };
  });
}

/** Phase headline for the timeline card. */
export function phaseHeadline(r: Release): string {
  switch (r.phase) {
    case "STAGING":
      return "Deploying to staging";
    case "VALIDATING":
      return "Sentinel is checking staging";
    case "AWAITING_TAP":
      return "Staging is healthy. Waiting for a human to ship it";
    case "CANARY":
      return `Canary at ${r.canaryPercent ?? 0}% of traffic`;
    case "SHIPPED":
      return "Shipped to production";
    case "FAILED":
      return "Failed before shipping";
    case "ROLLED_BACK":
      return "Canary failed. Rolled back to the stable version";
    case "SUPERSEDED":
      return "Superseded by a newer release";
  }
}

/** Plain "what happens next / what you need to do" line for the current phase. */
export function phaseHint(r: Release): string {
  switch (r.phase) {
    case "STAGING":
    case "VALIDATING":
      return "Nothing to do: this advances on its own.";
    case "AWAITING_TAP":
      return "Your move: review staging, then press TAP TO SHIP to start the canary.";
    case "CANARY":
      return `Nothing to do: the Sentinel checks each step and promotes automatically (${CANARY_STEPS.join(" → ")}%), or rolls back on a bad verdict.`;
    case "SHIPPED":
      return "Done: every request now hits the new version.";
    case "ROLLED_BACK":
      return "Production is back on the stable version. Fix the issue and land a new release.";
    case "FAILED":
      return "Nothing shipped. Check the summary below, then land a new release.";
    case "SUPERSEDED":
      return "A newer release replaced this one. No action needed.";
  }
}

/** The release summary, only where it describes the current phase (a stale canary step's line is hidden mid-canary). */
export function releaseSummary(r: Release): string | null {
  if (!r.summary) return null;
  if (r.phase === "CANARY" || r.phase === "STAGING" || r.phase === "VALIDATING") return null;
  return r.summary;
}

// ── tap to ship ───────────────────────────────────────────────────────────

export interface TapButtonState {
  visible: boolean;
  enabled: boolean;
  label: string;
}

/** The ship button: only in AWAITING_TAP; disabled while a tap is in flight or after one was sent. */
export function tapButtonState(release: Release | null, opts: { pending?: boolean; sentFor?: string | null } = {}): TapButtonState {
  if (!release || release.phase !== "AWAITING_TAP") return { visible: false, enabled: false, label: "" };
  if (opts.pending) return { visible: true, enabled: false, label: "Shipping…" };
  if (opts.sentFor === release.releaseId) return { visible: true, enabled: false, label: "Tap sent, waiting for the Queen…" };
  return { visible: true, enabled: true, label: "TAP TO SHIP" };
}

export function tapErrorMessage(status: number, message: string): string {
  if (status === 401 || status === 403) return "Your session expired. Reload the page to sign in again, then retry.";
  if (status === 409) return "This release is stale: a newer release or a state change replaced it. The page will update; check the timeline and tap again if needed.";
  if (status === 404) return "The Queen does not know this release any more. Reload the War Room.";
  if (status === 0) return message;
  return message || `The tap was rejected (${status}).`;
}

// ── sites ─────────────────────────────────────────────────────────────────

export const shortVersion = (id: string | null | undefined) => (id ? id.slice(0, 8) : null);

export interface SiteReleaseView {
  staging: { url: string | null; phase: ReleasePhase; verdict: SentinelVerdict | null; releaseId: string } | null;
  canary:
    | {
        /** Traffic percent shown on the bar (100 once shipped, the peak when rolled back). */
        percent: number;
        phase: ReleasePhase;
        candidate: string | null;
        stable: string | null;
        verdict: SentinelVerdict | null;
        live: boolean;
        releaseId: string;
      }
    | null;
  prod: { url: string | null; stable: string | null; tappedBy: string | null; releaseId: string } | null;
}

export function siteReleaseView(state: Pick<State, "releases" | "releaseOrder" | "verdicts" | "canaryPeak">): SiteReleaseView {
  const rels = state.releaseOrder.map((id) => state.releases[id]!).filter(Boolean);
  const stagingRel = rels.find((r) => r.stagingUrl || r.phase === "STAGING" || r.phase === "VALIDATING");
  const canaryRel = rels.find((r) => r.phase === "CANARY" || r.phase === "ROLLED_BACK" || (r.phase === "SHIPPED" && r.candidateVersionId));
  const shipped = rels.find((r) => r.phase === "SHIPPED");
  const prodUrl = shipped?.prodUrl ?? rels.find((r) => r.prodUrl)?.prodUrl ?? null;
  return {
    staging: stagingRel
      ? { url: stagingRel.stagingUrl, phase: stagingRel.phase, verdict: state.verdicts[stagingRel.releaseId]?.staging ?? null, releaseId: stagingRel.releaseId }
      : null,
    canary: canaryRel
      ? {
          percent: canaryRel.phase === "SHIPPED" ? 100 : canaryRel.phase === "ROLLED_BACK" ? Math.max(state.canaryPeak[canaryRel.releaseId] ?? 0, canaryRel.canaryPercent ?? 0) : (canaryRel.canaryPercent ?? 0),
          phase: canaryRel.phase,
          candidate: shortVersion(canaryRel.candidateVersionId),
          stable: shortVersion(canaryRel.stableVersionId),
          verdict: state.verdicts[canaryRel.releaseId]?.canary ?? null,
          live: canaryRel.phase === "CANARY",
          releaseId: canaryRel.releaseId,
        }
      : null,
    prod:
      shipped || prodUrl
        ? { url: prodUrl, stable: shortVersion(shipped?.candidateVersionId ?? rels.find((r) => r.stableVersionId)?.stableVersionId), tappedBy: shipped?.tappedBy ?? null, releaseId: shipped?.releaseId ?? "" }
        : null,
  };
}

// ── prod link and the status-home strip ───────────────────────────────────

/** The production URL: the shipped release's, else any release's, else a LIVE prod deployment's (what the Sites panel shows). */
export function prodUrlOf(state: Pick<State, "releases" | "releaseOrder" | "deployments">, release?: Release | null): string | null {
  if (release?.prodUrl) return release.prodUrl;
  const rels = state.releaseOrder.map((id) => state.releases[id]).filter((r): r is Release => !!r);
  const fromRelease = rels.find((r) => r.phase === "SHIPPED" && r.prodUrl)?.prodUrl ?? rels.find((r) => r.prodUrl)?.prodUrl;
  if (fromRelease) return fromRelease;
  const prod = Object.values(state.deployments)
    .filter((d) => d.environment === "prod" && d.url && d.status !== "TORN_DOWN")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return prod[0]?.url ?? null;
}

/** Who shipped it: the Queen on her own, a person, or null when not (yet) tapped. */
export function shipper(r: Release): { kind: "auto" | "human"; by: string } | null {
  if (!r.tappedBy) return null;
  return r.tappedBy === AUTO_SHIP_ACTOR ? { kind: "auto", by: r.tappedBy } : { kind: "human", by: r.tappedBy };
}

export interface ReleaseStrip {
  release: Release;
  steps: TimelineStep[];
  headline: string;
  shipper: ReturnType<typeof shipper>;
  /** Set once SHIPPED and a URL is known. */
  prodUrl: string | null;
}

/** The status-home release strip: the newest release, or null when there is none. */
export function releaseStrip(state: Pick<State, "releases" | "releaseOrder" | "deployments" | "canaryPeak">): ReleaseStrip | null {
  const release = currentRelease(state);
  if (!release) return null;
  return {
    release,
    steps: timelineSteps(release, state.canaryPeak[release.releaseId] ?? 0),
    headline: phaseHeadline(release),
    shipper: shipper(release),
    prodUrl: release.phase === "SHIPPED" ? prodUrlOf(state, release) : null,
  };
}
