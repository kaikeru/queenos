import { describe, expect, it } from "vitest";
import { devFakesProvisioner } from "../src/ports";

describe("devFakesProvisioner (dev-only seam)", () => {
  it("requires the explicit flag", () => expect(devFakesProvisioner({})).toBe(false));
  it("is on with the flag", () => expect(devFakesProvisioner({ GENESIS_DEV_FAKE_PROVISIONER: "1" })).toBe(true));
  it("is on with the flag even though wrangler declares a (not running) PROVISIONER binding", () =>
    expect(devFakesProvisioner({ GENESIS_DEV_FAKE_PROVISIONER: "1", PROVISIONER: {} as never })).toBe(true));
  it("ignores other flag values", () => expect(devFakesProvisioner({ GENESIS_DEV_FAKE_PROVISIONER: "true" })).toBe(false));
});
