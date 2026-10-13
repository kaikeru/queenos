import { describe, expect, it } from "vitest";
import { BindingArtifactsPort } from "../src/ports";

/** A minimal Artifacts binding: `get(repo)` returns a handle whose `log` is scripted. */
function binding(log: () => Promise<unknown[]>, getError?: Error) {
  return {
    get: async () => {
      if (getError) throw getError;
      return { log, [Symbol.dispose]() {} };
    },
  } as unknown as ConstructorParameters<typeof BindingArtifactsPort>[0];
}
const notFound = () => Object.assign(new Error("not found"), { code: "NOT_FOUND" });

describe("BindingArtifactsPort.readHead", () => {
  it("reads the head sha and message", async () => {
    const port = new BindingArtifactsPort(binding(async () => [{ hash: "a".repeat(40), message: "hi" }]));
    expect(await port.readHead("r")).toEqual({ sha: "a".repeat(40), message: "hi" });
  });

  it("a fork with no `main` yet (log NOT_FOUND) reads as gone, not as a failure", async () => {
    const port = new BindingArtifactsPort(binding(async () => Promise.reject(notFound())));
    expect(await port.readHead("r")).toBeNull();
  });

  it("a deleted repo (get NOT_FOUND) reads as gone; other log errors still throw", async () => {
    expect(await new BindingArtifactsPort(binding(async () => [], notFound())).readHead("r")).toBeNull();
    await expect(new BindingArtifactsPort(binding(async () => Promise.reject(new Error("boom")))).readHead("r")).rejects.toThrow("boom");
  });
});
