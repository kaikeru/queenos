import { describe, expect, it } from "vitest";
import { createProdPorts, VaultCredentialsPort, type VaultReaderRpc } from "../src/ports";
import { runHerald } from "../src/orchestrate";
import { FakeWorld, InlineSteps, TOKEN, deploy, teardown } from "./fakes";

class FakeVaultReader implements VaultReaderRpc {
  readonly calls: { hive: string; purpose?: string }[] = [];
  async getCloudflareCredential(hive: string, purpose?: string) {
    this.calls.push({ hive, ...(purpose ? { purpose } : {}) });
    return { accountId: "acct-vault", apiToken: TOKEN };
  }
}

describe("VaultCredentialsPort", () => {
  it("reads the hive's credential from the VaultReader binding, passing the audit purpose", async () => {
    const vault = new FakeVaultReader();
    const creds = await new VaultCredentialsPort(vault).cloudflare("acme", "herald DEPLOY cmd-1");
    expect(creds).toEqual({ accountId: "acct-vault", token: TOKEN });
    expect(vault.calls).toEqual([{ hive: "acme", purpose: "herald DEPLOY cmd-1" }]);
  });

  it("fails closed (permanent UNAVAILABLE) without the binding", async () => {
    await expect(new VaultCredentialsPort(undefined).cloudflare("acme")).rejects.toThrow(/^UNAVAILABLE: VAULT_READER binding is not configured/);
  });

  it("is the production default; no env token is consulted", async () => {
    const vault = new FakeVaultReader();
    const ports = createProdPorts({ VAULT_READER: vault, CLOUDFLARE_API_TOKEN: "env-token" } as never);
    expect(ports.credentials).toBeInstanceOf(VaultCredentialsPort);
    expect((await ports.credentials.cloudflare("acme")).token).toBe(TOKEN);
  });
});

describe("credential use in the Herald", () => {
  it("fetches per hive with the command id as the audit purpose, inside each step", async () => {
    const w = new FakeWorld();
    const steps = new InlineSteps();
    await runHerald(deploy({ hive: "acme" }), steps, w.ports());
    await runHerald(teardown({ hive: "acme" }), steps, w.ports());
    expect(w.credentials.requests).toEqual([
      { hive: "acme", purpose: "herald DEPLOY cmd-1" },
      { hive: "acme", purpose: "herald DEPLOY cmd-1" },
      { hive: "acme", purpose: "herald TEARDOWN cmd-2" },
    ]);
    for (const r of steps.results) expect(r).not.toContain(TOKEN);
  });
});
