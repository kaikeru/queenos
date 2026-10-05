/** Canned prompts for the demo swarm. In the sim, "[fail]" is ejected by the security scan and "[review-fail]" by the REVIEWER; each REWORK passes. The other two are clean. */
export const DEMO_PROMPTS: readonly string[] = [
  "Add rate limiting middleware to the public API",
  "Fix the flaky retry logic in the webhook sender [fail]",
  "Add a /changelog page that lists recent releases [review-fail]",
  "Write a migration that indexes audit_trail by prompt",
];
