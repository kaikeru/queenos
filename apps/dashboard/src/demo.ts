/** Canned prompts for the demo swarm. In the sim, "[fail]" is ejected by the security scan and "[review-fail]" by the REVIEWER; each REWORK passes. The other two are clean. */
export const DEMO_PROMPTS: readonly string[] = [
  "Add rate limiting middleware to the public API",
  "Fix the flaky retry logic in the webhook sender [fail]",
  "Add a /changelog page that lists recent releases [review-fail]",
  "Write a migration that indexes audit_trail by prompt",
];

// ── v2 swarm demo ─────────────────────────────────────────────────────────
// Mirrors `demoSwarmPrompt` in apps/queen/src/sim/sim-v2.ts (the dashboard cannot import apps/queen).

const RACE_MARKER = "[race]";
const COLLIDE_MARKER = "[collide]";
const BATCH_FAIL_MARKER = "[batch-fail]";
const SWARM_WORDS = [
  "otter", "falcon", "maple", "comet", "harbor", "lantern", "meadow", "quartz", "willow", "ember", "glacier", "pebble",
  "saffron", "tundra", "velvet", "zephyr", "acorn", "bramble", "cobalt", "dune", "fjord", "garnet", "heron", "indigo",
  "juniper", "kelp", "lichen", "mosaic", "nectar", "orchid", "prairie", "quill",
];

/** An n-bullet goal prompt. One bullet races, two collide on shared paths, one fails the batch gate. */
export function demoSwarmPrompt(n: number): string {
  const count = Math.max(1, Math.floor(n));
  const marks = new Map<number, string>();
  const place = (frac: number, marker: string) => {
    let i = Math.min(count - 1, Math.floor(count * frac));
    while (marks.has(i) && i < count - 1) i++;
    while (marks.has(i) && i > 0) i--;
    if (!marks.has(i)) marks.set(i, marker);
  };
  place(0.12, RACE_MARKER);
  place(0.3, COLLIDE_MARKER);
  place(0.4, COLLIDE_MARKER);
  place(0.7, BATCH_FAIL_MARKER);
  return Array.from({ length: count }, (_, i) => {
    const w = i < SWARM_WORDS.length ? SWARM_WORDS[i]! : `${SWARM_WORDS[i % SWARM_WORDS.length]!}${Math.floor(i / SWARM_WORDS.length)}`;
    const marker = marks.get(i);
    return `- Add a /features/${w} endpoint returning ${w} facts${marker ? ` ${marker}` : ""}`;
  }).join("\n");
}

/** Sample size of the one-click swarm demo. */
export const SWARM_DEMO_SIZE = 24;
