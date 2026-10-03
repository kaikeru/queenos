import { expect, test } from "vitest";
import type { VaultStatus, WizardStep } from "@queenos/queen-types";
import {
  STEPPER,
  addTag,
  charterFormFromDraft,
  connectReducer,
  initialConnect,
  isPolling,
  previewFromDraft,
  screenFor,
  slugify,
  stepperIndex,
  timelineFor,
  validateCharter,
  validateConnect,
  validateSlug,
  verificationFailed,
} from "../src/wizardLogic";

test("step maps to the right screen", () => {
  const cases: [WizardStep, string][] = [
    ["DESCRIBE", "describe"],
    ["CHARTER_READY", "connect"],
    ["DEPLOY_CONNECTED", "launch"],
    ["HIVE_CREATING", "flight"],
    ["FIRST_FLIGHT", "flight"],
    ["ACTIVE", "active"],
    ["FAILED", "failed"],
  ];
  for (const [step, screen] of cases) expect(screenFor(step)).toBe(screen);
});

test("DESCRIBE shows the review form only while reviewing; other steps ignore it", () => {
  expect(screenFor("DESCRIBE", true)).toBe("review");
  expect(screenFor("CHARTER_READY", true)).toBe("connect");
});

test("stepper index follows the screen and finishes on ACTIVE", () => {
  expect(stepperIndex("describe")).toBe(0);
  expect(stepperIndex("review")).toBe(1);
  expect(stepperIndex("connect")).toBe(2);
  expect(stepperIndex("launch")).toBe(3);
  expect(stepperIndex("flight")).toBe(4);
  expect(stepperIndex("active")).toBe(STEPPER.length);
  expect(stepperIndex("failed")).toBe(4);
});

test("polling only during first flight", () => {
  expect(isPolling("HIVE_CREATING")).toBe(true);
  expect(isPolling("FIRST_FLIGHT")).toBe(true);
  expect(isPolling("ACTIVE")).toBe(false);
  expect(isPolling("DESCRIBE")).toBe(false);
});

test("timeline progresses with the step", () => {
  const states = (s: WizardStep) => timelineFor(s).map((t) => t.state);
  expect(states("HIVE_CREATING")).toEqual(["active", "active", "pending", "pending"]);
  expect(states("FIRST_FLIGHT")).toEqual(["done", "done", "done", "active"]);
  expect(states("ACTIVE")).toEqual(["done", "done", "done", "done"]);
});

const valid = () => ({
  ...charterFormFromDraft("demo", { name: "Demo", description: "Does a thing", firstPrompt: "Build it" }),
});

test("charter form fills defaults from a partial draft", () => {
  const c = charterFormFromDraft("demo", null);
  expect(c.hive).toBe("demo");
  expect(c.environments).toEqual({ preview: true, staging: true, prod: true });
  expect(c.secrets).toEqual(["cloudflare"]);
  const d = charterFormFromDraft("demo", { name: "X", policy: { allowedDeps: ["hono", 3] }, environments: { prod: false } });
  expect(d.policy.allowedDeps).toEqual(["hono"]);
  expect(d.environments.prod).toBe(false);
});

test("charter validation accepts a complete charter", () => {
  const r = validateCharter(valid());
  expect(r.ok).toBe(true);
});

test("charter validation reports required fields by key", () => {
  const r = validateCharter(charterFormFromDraft("demo", null));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(Object.keys(r.errors).sort()).toEqual(["description", "firstPrompt", "name"]);
    expect(r.errors.name).toBe("Required");
  }
});

test("charter validation enforces length limits", () => {
  const r = validateCharter({ ...valid(), name: "x".repeat(81), firstPrompt: "y".repeat(4001) });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errors.name).toBe("Max 80 characters");
    expect(r.errors.firstPrompt).toBe("Max 4000 characters");
  }
});

test("charter preview completeness", () => {
  expect(previewFromDraft(null).completeness).toBe(0);
  expect(previewFromDraft({ name: "a", description: "b" }).completeness).toBeCloseTo(2 / 3);
  expect(previewFromDraft({ name: "a", description: "b", firstPrompt: "c" }).completeness).toBe(1);
});

test("tag input dedupes and trims", () => {
  expect(addTag(["a"], " b, ")).toEqual(["a", "b"]);
  expect(addTag(["a"], "a")).toEqual(["a"]);
  expect(addTag(["a"], "  ")).toEqual(["a"]);
});

test("slug helpers", () => {
  expect(slugify("Pixel Pulse!")).toBe("pixel-pulse");
  expect(slugify("42 Things")).toBe("things");
  expect(validateSlug("pixel-pulse")).toBeNull();
  expect(validateSlug("Pixel")).not.toBeNull();
  expect(validateSlug("ab")).not.toBeNull();
  expect(validateSlug("-abc")).not.toBeNull();
});

test("connect form validates account id and token", () => {
  expect(validateConnect({ accountId: "nope", apiToken: "short" })).toEqual({
    ok: false,
    errors: { accountId: "Account ID is 32 hex characters", apiToken: "Paste the full API token (20+ characters)" },
  });
  const ok = validateConnect({ accountId: `${"a".repeat(32)} `, apiToken: " t".repeat(15) });
  expect(ok.ok).toBe(true);
});

const status = (connected: boolean): VaultStatus => ({
  hive: "demo",
  secret: "cloudflare",
  connected,
  accountId: connected ? "a".repeat(32) : null,
  verifiedAt: connected ? 1 : null,
  checks: [{ name: "token active", ok: connected }],
});

test("the API token is cleared from state immediately on submit, whatever the result", () => {
  let s = connectReducer(initialConnect, { type: "edit", field: "apiToken", value: "super-secret-token-value-123" });
  s = connectReducer(s, { type: "edit", field: "accountId", value: "a".repeat(32) });
  expect(s.apiToken).toBe("super-secret-token-value-123");

  const submitted = connectReducer(s, { type: "submit" });
  expect(submitted.apiToken).toBe("");
  expect(submitted.accountId).toBe("a".repeat(32));
  expect(submitted.phase).toBe("submitting");

  expect(connectReducer(submitted, { type: "result", status: status(true) }).apiToken).toBe("");
  expect(connectReducer(submitted, { type: "result", status: status(false) }).apiToken).toBe("");
  expect(connectReducer(submitted, { type: "error", message: "boom" }).apiToken).toBe("");
  expect(JSON.stringify(connectReducer(submitted, { type: "result", status: status(true) }))).not.toContain("super-secret");
});

test("connect result sets the phase from VaultStatus.connected", () => {
  const sub = connectReducer(initialConnect, { type: "submit" });
  expect(connectReducer(sub, { type: "result", status: status(true) }).phase).toBe("connected");
  const failed = connectReducer(sub, { type: "result", status: status(false) });
  expect(failed.phase).toBe("failed");
  expect(failed.status?.checks[0]?.ok).toBe(false);
});

test("verificationFailed: false for a never-connected hive (no checks yet)", () => expect(verificationFailed({ connected: false, checks: [] })).toBe(false));
test("verificationFailed: true after a rejected verification", () => expect(verificationFailed({ connected: false, checks: [{ name: "x", ok: false }] })).toBe(true));
test("verificationFailed: false when connected or absent", () => {
  expect(verificationFailed({ connected: true, checks: [{ name: "x", ok: true }] })).toBe(false);
  expect(verificationFailed(null)).toBe(false);
});
