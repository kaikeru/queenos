/**
 * Secret guard for the chat. Credentials go through the Connect form
 * (browser -> edge -> Vault), never through Genesis and never into a prompt.
 * Patterns are a subset of apps/gatekeepers/src/security.ts plus a generic
 * "long opaque token" rule that catches Cloudflare API tokens (40 chars).
 */
const RULES: { id: string; re: RegExp }[] = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "artifacts-token", re: /\bart_v\d+_[A-Za-z0-9_]{20,}/ },
  { id: "cloudflare-token", re: /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/ },
  { id: "generic-secret", re: /\b(?:api[_-]?key|secret|passw(?:or)?d|auth[_-]?token|access[_-]?token|bearer)\b["']?\s*[:=]?\s*["']?[A-Za-z0-9/+_=.-]{20,}/i },
  // A single 40+ char run of [A-Za-z0-9_-] that mixes letters and digits.
  { id: "opaque-token", re: /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/ },
];

/** The id of the first rule that matches, or null when the text looks clean. */
export function findSecret(text: string): string | null {
  for (const r of RULES) if (r.re.test(text)) return r.id;
  return null;
}

export const SECRET_REFUSAL =
  "That looks like a secret or API token, so I did not send it to the model or store it. Please use the Connect Cloudflare form for credentials. It sends them straight to the Vault, and I never see them. If your token is already stored, you can keep describing the app here.";
export const SECRET_PLACEHOLDER = "[message withheld: it looked like a secret]";
