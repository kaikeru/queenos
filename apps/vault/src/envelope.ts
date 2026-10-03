/**
 * Envelope encryption for the Vault (docs/deploy-discovery.md §6). Web Crypto only.
 *
 * - KEK: the Worker secret `VAULT_KEK` (base64, 32 bytes), imported once per
 *   isolate as a non-extractable AES-KW key. `VAULT_KEK_PREVIOUS` (optional)
 *   is the KEK being rotated out: it can only unwrap.
 * - KEK version: a fingerprint of the KEK, `k1-` + 16 hex chars of
 *   SHA-256("queenos/vault/kek-id/v1" || kek). Stored next to each wrapped DEK
 *   so a row says which KEK wrapped it, without revealing that KEK.
 * - DEK: a random AES-256-GCM key per hive, stored only wrapped (AES-KW, RFC 3394).
 * - Secret values: AES-256-GCM under the DEK, a fresh random 96-bit IV per
 *   write, 128-bit tag, AAD = `hive|secretName|version` so a ciphertext cannot
 *   be replayed under another hive, secret or version.
 *
 * Plaintext only ever exists as a short-lived Uint8Array inside one call; the
 * buffers we own are zeroized before returning (JS strings cannot be).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const KEK_BYTES = 32;
export const IV_BYTES = 12;
const KEK_ID_DOMAIN = "queenos/vault/kek-id/v1";

export class VaultCryptoError extends Error {
  override readonly name = "VaultCryptoError";
}

export interface Kek {
  /** Fingerprint stored as `kek_version`. */
  readonly id: string;
  readonly key: CryptoKey;
}

export interface KeyringEnv {
  VAULT_KEK?: string;
  VAULT_KEK_PREVIOUS?: string;
}

export interface Keyring {
  current: Kek;
  /** Only for unwrapping DEKs written before a rotation. */
  previous: Kek | null;
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Overwrite a buffer we own. Best effort: the engine may hold other copies. */
export function zeroize(...bufs: (Uint8Array | ArrayBuffer | null | undefined)[]): void {
  for (const b of bufs) if (b) (b instanceof Uint8Array ? b : new Uint8Array(b)).fill(0);
}

/** Import a base64 KEK. Never echoes the input in an error. */
export async function importKek(b64: string): Promise<Kek> {
  let raw: Uint8Array;
  try {
    raw = b64decode(b64);
  } catch {
    throw new VaultCryptoError("KEK is not valid base64");
  }
  try {
    if (raw.byteLength !== KEK_BYTES) throw new VaultCryptoError(`KEK must decode to ${KEK_BYTES} bytes`);
    const domain = enc.encode(KEK_ID_DOMAIN);
    const material = new Uint8Array(domain.byteLength + raw.byteLength);
    material.set(domain);
    material.set(raw, domain.byteLength);
    const digest = await crypto.subtle.digest("SHA-256", material);
    zeroize(material);
    const id = `k1-${hex(digest).slice(0, 16)}`;
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-KW" }, false, ["wrapKey", "unwrapKey"]);
    return { id, key };
  } finally {
    zeroize(raw);
  }
}

// One import per isolate per distinct secret value (rotation swaps the value).
const kekCache = new Map<string, Promise<Kek>>();

function cachedKek(b64: string): Promise<Kek> {
  let p = kekCache.get(b64);
  if (!p) {
    p = importKek(b64);
    p.catch(() => kekCache.delete(b64));
    kekCache.set(b64, p);
  }
  return p;
}

/** The isolate's keyring from env. Throws UNAVAILABLE when VAULT_KEK is missing or malformed. */
export async function keyringFromEnv(env: KeyringEnv): Promise<Keyring> {
  const cur = env.VAULT_KEK?.trim();
  if (!cur) throw new VaultCryptoError("UNAVAILABLE: the VAULT_KEK secret is not configured");
  let current: Kek;
  try {
    current = await cachedKek(cur);
  } catch (e) {
    throw new VaultCryptoError(`UNAVAILABLE: VAULT_KEK is malformed (${(e as Error).message})`);
  }
  const prev = env.VAULT_KEK_PREVIOUS?.trim();
  let previous: Kek | null = null;
  if (prev) {
    try {
      previous = await cachedKek(prev);
    } catch (e) {
      throw new VaultCryptoError(`UNAVAILABLE: VAULT_KEK_PREVIOUS is malformed (${(e as Error).message})`);
    }
  }
  return { current, previous: previous && previous.id !== current.id ? previous : null };
}

// ── DEKs ─────────────────────────────────────────────────────────────────

export interface WrappedDek {
  wrapped: Uint8Array;
  kekVersion: string;
}

/** A fresh per-hive data key, wrapped by the current KEK. */
export async function newWrappedDek(ring: Keyring): Promise<{ dek: CryptoKey; wrapped: WrappedDek }> {
  // Extractable only so it can be wrapped; the caller drops it after this call.
  const dek = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])) as CryptoKey;
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dek, ring.current.key, { name: "AES-KW" }));
  return { dek, wrapped: { wrapped, kekVersion: ring.current.id } };
}

/**
 * Unwrap a stored DEK. A DEK wrapped by `previous` is re-wrapped under
 * `current` (lazy KEK rotation): the caller persists `rewrapped` when present.
 */
export async function unwrapDek(ring: Keyring, stored: WrappedDek): Promise<{ dek: CryptoKey; rewrapped: WrappedDek | null }> {
  const kek = stored.kekVersion === ring.current.id ? ring.current : stored.kekVersion === ring.previous?.id ? ring.previous : null;
  if (!kek) throw new VaultCryptoError("UNAVAILABLE: this hive's data key is wrapped by an unknown KEK version");
  const rotate = kek !== ring.current;
  let dek: CryptoKey;
  try {
    dek = await crypto.subtle.unwrapKey("raw", stored.wrapped, kek.key, { name: "AES-KW" }, { name: "AES-GCM", length: 256 }, rotate, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    throw new VaultCryptoError("UNAVAILABLE: could not unwrap this hive's data key (wrong KEK or corrupted row)");
  }
  if (!rotate) return { dek, rewrapped: null };
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dek, ring.current.key, { name: "AES-KW" }));
  // Re-import as non-extractable for the rest of this call.
  const usable = await crypto.subtle.unwrapKey("raw", wrapped, ring.current.key, { name: "AES-KW" }, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { dek: usable, rewrapped: { wrapped, kekVersion: ring.current.id } };
}

// ── values ───────────────────────────────────────────────────────────────

/** AAD binding a ciphertext to its hive, secret name and version. */
export function aadFor(hive: string, secret: string, version: number): Uint8Array {
  return enc.encode(`${hive}|${secret}|${version}`);
}

export interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

/** Encrypts and zeroizes `plaintext` (the caller's buffer). */
export async function seal(dek: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Sealed> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, dek, plaintext));
    return { iv, ct };
  } finally {
    zeroize(plaintext);
  }
}

/** Fails (no partial output) on a tampered ciphertext/IV, wrong AAD or wrong key. */
export async function open(dek: CryptoKey, sealed: Sealed, aad: Uint8Array): Promise<Uint8Array> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv, additionalData: aad, tagLength: 128 }, dek, sealed.ct));
  } catch {
    throw new VaultCryptoError("UNAVAILABLE: secret failed authentication (tampered, wrong key or wrong context)");
  }
}

/** JSON helpers that zeroize the intermediate bytes. */
export function encodeJson(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

export function decodeJson<T>(bytes: Uint8Array): T {
  try {
    return JSON.parse(dec.decode(bytes)) as T;
  } finally {
    zeroize(bytes);
  }
}
