/**
 * Pre-filled Cloudflare "create API token" deep link (docs/deploy-discovery.md
 * §6, "Cloudflare credentials" → "Deep link exists"; permission keys from
 * CF:fundamentals/api/how-to/account-owned-token-template).
 *
 * An ACCOUNT-owned token (`/?to=/:account/api-tokens`; the dashboard asks
 * which account), because connectCloudflare verifies it with
 * `GET /accounts/{id}/tokens/verify`. Minimal permissions:
 * - `workers_scripts: edit`: upload Workers, versions, deployments and Worker
 *   Previews (Previews hang off the Workers Scripts API; no separate key is
 *   documented, §2).
 * - `account_analytics: read`: Sentinel health signals (§4).
 * Not requested: `workers_routes: edit` (only needed for custom domains, §8)
 * and an Observability read key (UNVERIFIED in §6).
 */
export const TOKEN_PERMISSION_GROUPS: readonly { key: string; type: "read" | "edit" }[] = [
  { key: "workers_scripts", type: "edit" },
  { key: "account_analytics", type: "read" },
];

export const TOKEN_NAME = "QueenOS Deploy";

export const TOKEN_TEMPLATE_URL =
  "https://dash.cloudflare.com/?to=/:account/api-tokens" +
  `&permissionGroupKeys=${encodeURIComponent(JSON.stringify(TOKEN_PERMISSION_GROUPS))}` +
  `&name=${encodeURIComponent(TOKEN_NAME)}`;
