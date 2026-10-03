import { CLOUDFLARE_API_ORIGIN, type CloudflareFetch } from "@queenos/hive-kit";

/**
 * DEV ONLY: `VAULT_DEV_CF_BASE` (set via .dev.vars, never in wrangler.jsonc)
 * redirects Cloudflare API calls to a local fake. Unset: plain fetch.
 */
export function cloudflareFetchFor(base: string | undefined): CloudflareFetch {
  const b = base?.trim().replace(/\/+$/, "");
  if (!b) return (input, init) => fetch(input, init);
  return (input, init) => {
    return fetch(input.startsWith(CLOUDFLARE_API_ORIGIN) ? b + input.slice(CLOUDFLARE_API_ORIGIN.length) : input, init);
  };
}
