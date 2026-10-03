import { describe, expect, it } from "vitest";
import {
  aadFor,
  b64encode,
  decodeJson,
  encodeJson,
  importKek,
  keyringFromEnv,
  newWrappedDek,
  open,
  seal,
  unwrapDek,
  type Keyring,
} from "../src/envelope";
import { KEK_A, KEK_B } from "./fakes";

const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function ring(current: string, previous?: string): Promise<Keyring> {
  return keyringFromEnv({ VAULT_KEK: current, ...(previous ? { VAULT_KEK_PREVIOUS: previous } : {}) });
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("known-answer vectors (the platform primitives we rely on)", () => {
  it("AES-KW: RFC 3394 §4.6 (256-bit KEK wrapping 256-bit key data)", async () => {
    const kek = await crypto.subtle.importKey("raw", fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"), "AES-KW", false, ["wrapKey"]);
    const data = await crypto.subtle.importKey("raw", fromHex("00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f"), "AES-GCM", true, ["encrypt"]);
    const wrapped = await crypto.subtle.wrapKey("raw", data, kek, "AES-KW");
    expect(toHex(wrapped)).toBe("28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21");
  });

  it("AES-256-GCM: McGrew-Viega test case 14", async () => {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt"]);
    const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), tagLength: 128 }, key, new Uint8Array(16));
    expect(toHex(out)).toBe("cea7403d4d606b6e074ec5d3baf39d18" + "d0d1c8a799996bf0265b98b5d48ab919");
  });
});

describe("envelope", () => {
  const secret = { accountId: "acct", apiToken: "tok-SECRET-value" };

  it("round-trips a value: DEK wrapped by the KEK, value sealed under the DEK", async () => {
    const r = await ring(KEK_A);
    const { dek, wrapped } = await newWrappedDek(r);
    expect(wrapped.wrapped.byteLength).toBe(40);
    expect(wrapped.kekVersion).toMatch(/^k1-[0-9a-f]{16}$/);
    const plaintext = encodeJson(secret);
    const sealed = await seal(dek, plaintext, aadFor("hive-a", "cloudflare", 1));
    expect([...plaintext].every((b) => b === 0)).toBe(true); // caller's buffer zeroized
    expect(sealed.iv.byteLength).toBe(12);
    expect(sealed.ct.byteLength).toBe(new TextEncoder().encode(JSON.stringify(secret)).byteLength + 16);

    const { dek: again, rewrapped } = await unwrapDek(r, wrapped);
    expect(rewrapped).toBeNull();
    const bytes = await open(again, sealed, aadFor("hive-a", "cloudflare", 1));
    expect(decodeJson(bytes)).toEqual(secret);
    expect([...bytes].every((b) => b === 0)).toBe(true); // decoded buffer zeroized
  });

  it("uses a fresh IV per seal", async () => {
    const { dek } = await newWrappedDek(await ring(KEK_A));
    const a = await seal(dek, encodeJson(secret), aadFor("h", "s", 1));
    const b = await seal(dek, encodeJson(secret), aadFor("h", "s", 1));
    expect(toHex(a.iv)).not.toBe(toHex(b.iv));
    expect(toHex(a.ct)).not.toBe(toHex(b.ct));
  });

  it("rejects tampered ciphertext, tampered IV and a wrong AAD (hive, secret or version)", async () => {
    const { dek } = await newWrappedDek(await ring(KEK_A));
    const aad = aadFor("hive-a", "cloudflare", 2);
    const sealed = await seal(dek, encodeJson(secret), aad);

    const ct = sealed.ct.slice();
    ct[3]! ^= 0x01;
    expect(await errorOf(open(dek, { ...sealed, ct }, aad))).toMatch(/failed authentication/);
    const tag = sealed.ct.slice();
    tag[tag.length - 1]! ^= 0x80;
    expect(await errorOf(open(dek, { ...sealed, ct: tag }, aad))).toMatch(/failed authentication/);
    const iv = sealed.iv.slice();
    iv[0]! ^= 0x01;
    expect(await errorOf(open(dek, { ...sealed, iv }, aad))).toMatch(/failed authentication/);

    for (const wrong of [aadFor("hive-b", "cloudflare", 2), aadFor("hive-a", "aws", 2), aadFor("hive-a", "cloudflare", 1)]) {
      expect(await errorOf(open(dek, sealed, wrong))).toMatch(/failed authentication/);
    }
    expect(decodeJson(await open(dek, sealed, aad))).toEqual(secret);
  });

  it("a wrong KEK cannot unwrap the DEK (same version label, different key)", async () => {
    const a = await ring(KEK_A);
    const b = await ring(KEK_B);
    const { wrapped } = await newWrappedDek(a);
    // Unknown version: refused before trying.
    expect(await errorOf(unwrapDek(b, wrapped))).toMatch(/unknown KEK version/);
    // Forged label: AES-KW's integrity check fails.
    expect(await errorOf(unwrapDek(b, { ...wrapped, kekVersion: b.current.id }))).toMatch(/could not unwrap/);
    // A corrupted wrapped DEK fails too.
    const bad = wrapped.wrapped.slice();
    bad[5]! ^= 0xff;
    expect(await errorOf(unwrapDek(a, { ...wrapped, wrapped: bad }))).toMatch(/could not unwrap/);
  });

  it("KEK rotation: unwrap with VAULT_KEK_PREVIOUS, re-wrap under VAULT_KEK (lazily)", async () => {
    const old = await ring(KEK_A);
    const { dek, wrapped } = await newWrappedDek(old);
    const sealed = await seal(dek, encodeJson(secret), aadFor("h", "cloudflare", 1));

    const rotating = await ring(KEK_B, KEK_A);
    expect(rotating.previous?.id).toBe(old.current.id);
    const { dek: d1, rewrapped } = await unwrapDek(rotating, wrapped);
    expect(rewrapped).not.toBeNull();
    expect(rewrapped!.kekVersion).toBe(rotating.current.id);
    expect(toHex(rewrapped!.wrapped)).not.toBe(toHex(wrapped.wrapped));
    expect(decodeJson(await open(d1, sealed, aadFor("h", "cloudflare", 1)))).toEqual(secret);

    // After rotation the old KEK can be dropped: the re-wrapped DEK opens the same ciphertext.
    const rotated = await ring(KEK_B);
    const { dek: d2, rewrapped: none } = await unwrapDek(rotated, rewrapped!);
    expect(none).toBeNull();
    expect(decodeJson(await open(d2, sealed, aadFor("h", "cloudflare", 1)))).toEqual(secret);
    // ...but the un-rotated row no longer opens without VAULT_KEK_PREVIOUS.
    expect(await errorOf(unwrapDek(rotated, wrapped))).toMatch(/unknown KEK version/);
  });

  it("validates the KEK without echoing it", async () => {
    const short = b64encode(new Uint8Array(16).fill(7));
    expect(await errorOf(importKek(short))).toBe("KEK must decode to 32 bytes");
    expect(await errorOf(keyringFromEnv({}))).toMatch(/^UNAVAILABLE: the VAULT_KEK secret is not configured/);
    const msg = await errorOf(keyringFromEnv({ VAULT_KEK: "!!not base64!!" }));
    expect(msg).toMatch(/^UNAVAILABLE: VAULT_KEK is malformed/);
    expect(msg).not.toContain("not base64!!");
    // Same KEK twice: no bogus "previous".
    expect((await ring(KEK_A, KEK_A)).previous).toBeNull();
    // The version label is a stable fingerprint, distinct per KEK.
    expect((await ring(KEK_A)).current.id).toBe((await importKek(KEK_A)).id);
    expect((await ring(KEK_A)).current.id).not.toBe((await ring(KEK_B)).current.id);
  });
});
