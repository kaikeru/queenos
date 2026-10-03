/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but VaultNode gets a
 * fake Cloudflare API and (optionally) an overridden keyring via test hooks.
 */
import type { CloudflareFetch } from "@queenos/hive-kit";
import { keyringFromEnv, type Keyring } from "../src/envelope";
import { VaultNode as ProdVaultNode } from "../src/vault-node";
import { hooks } from "./fakes";

export { default, VaultReader, VaultWriter } from "../src/index";

export class VaultNode extends ProdVaultNode {
  protected override cloudflareFetch(): CloudflareFetch {
    return (input, init) => hooks.cloudflare.fetch(input, init);
  }
  protected override keyring(): Promise<Keyring> {
    return hooks.keys ? keyringFromEnv(hooks.keys) : super.keyring();
  }
}
