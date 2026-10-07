/**
 * The read path (docs/human-push-design.md §2.2, §7.5, §9): `info/refs` and `git-upload-pack` proxied to a
 * repo with a **read** token.
 * - The advertisement is filtered to `HEAD` + the default branch (v0/v1 `info/refs`, and v2 `ls-refs`).
 * - The push advertisement (`service=git-receive-pack`) is synthesized from the upload-pack one, so hive main
 *   never needs a write token: same refs, the receive-pack capabilities Artifacts advertises (§3.6 probe 2).
 * - Requests are small and buffered, so a 503 (the per-repo episodes) is retried with backoff; the pack
 *   response is streamed through.
 * - On the hive root, v2 notes requests go to `notes-pack.ts` (T2n).
 */
import type { NotesContext, NotesHandlers, V2Command } from "./notes-pack.js";
import { concat, dec, FLUSH, parsePkts, pkt, pktText, ZERO_SHA, type Pkt } from "./pktline.js";
import { httpEvidence, RETRY_AFTER_S, upstreamFetch, type GitEndpoint, type UpstreamDeps } from "./upstream.js";

/** Largest upload-pack request we buffer (wants/haves of a big negotiation stay far below). */
export const MAX_UPLOAD_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * The receive-pack capabilities Artifacts advertises (§3.6 probe 2). Pushes go to a fork with the same
 * server, so a client restricted to these speaks a subset of what the fork accepts.
 */
export const RECEIVE_PACK_CAPS = ["report-status", "delete-refs", "ofs-delta", "side-band-64k"];
export const AGENT = "agent=queenos-git/1";

/** Capabilities that would let a client fetch objects the filtered advert hides. */
const HIDDEN_WANT_CAPS = new Set(["allow-tip-sha1-in-want", "allow-reachable-sha1-in-want"]);

export interface ReadTarget {
  deps: UpstreamDeps;
  hive: string;
  /** The repo read: hive main (`<hive>`) or one train fork (`/t/<trainId>`). */
  repo: string;
  /** The branch the advert keeps (the repo's default branch). */
  branch: string;
  /** Notes handlers: set only on the hive root. */
  notes: { handlers: NotesHandlers; ctx: NotesContext } | null;
  log: string[];
}

const UPLOAD_RESULT = "application/x-git-upload-pack-result";

function gitResponse(body: BodyInit | null, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType, "cache-control": "no-cache" } });
}

/** Map a failed upstream response for the client; the evidence goes to the log (never a token). */
export async function upstreamFailure(res: Response, endpoint: GitEndpoint, t: { log: string[] }): Promise<Response> {
  const evidence = await httpEvidence(res, endpoint);
  t.log.push(`upstream ${evidence}`);
  if (res.status === 404) return new Response("QueenOS: repository not found\n", { status: 404 });
  if (res.status >= 500) {
    return new Response("QueenOS: the hive repository is busy (Artifacts 503); retry in a minute\n", {
      status: 503,
      headers: { "retry-after": String(RETRY_AFTER_S) },
    });
  }
  return new Response(`QueenOS: upstream git error (HTTP ${res.status})\n`, { status: 502 });
}

// ── advertisement filtering ─────────────────────────────────────────────

interface AdvertRef {
  sha: string;
  name: string;
}

/** Keep `HEAD` and `refs/heads/<branch>` (and nothing else: no other branches, no tags, no notes). */
function keepRef(name: string, branch: string): boolean {
  return name === "HEAD" || name === `refs/heads/${branch}`;
}

/**
 * Parse a v0/v1 smart-HTTP advertisement (`# service=…`, flush, [`version 1`], ref lines, flush).
 * Returns null for a v2 capability advertisement (`version 2`), which carries no refs.
 */
export function parseAdvert(body: Uint8Array): { service: string; version1: boolean; refs: AdvertRef[]; caps: string[] } | null {
  const pkts = parsePkts(body);
  let i = 0;
  const first = pkts[i++];
  if (!(first instanceof Uint8Array)) throw new Error("advert: missing service line");
  if (pktText(first) === "version 2") return null;
  const service = pktText(first).replace(/^# service=/, "");
  if (pkts[i] === "flush") i++;
  let version1 = false;
  const next = pkts[i];
  if (next instanceof Uint8Array) {
    const t = pktText(next);
    if (t === "version 2") return null;
    if (t === "version 1") {
      version1 = true;
      i++;
    }
  }
  const refs: AdvertRef[] = [];
  let caps: string[] = [];
  for (; i < pkts.length; i++) {
    const p = pkts[i]!;
    if (p === "flush") break;
    if (typeof p === "string") continue;
    let line = pktText(p);
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      caps = line.slice(nul + 1).trim().split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    const sp = line.indexOf(" ");
    const sha = line.slice(0, sp);
    const name = line.slice(sp + 1);
    if (name === "capabilities^{}") continue;
    refs.push({ sha, name });
  }
  return { service, version1, refs, caps };
}

export function renderAdvert(service: string, version1: boolean, refs: AdvertRef[], caps: string[]): Uint8Array {
  const lines: Uint8Array[] = [pkt(`# service=${service}\n`), FLUSH];
  if (version1) lines.push(pkt("version 1\n"));
  const capStr = caps.join(" ");
  if (refs.length === 0) lines.push(pkt(`${ZERO_SHA} capabilities^{}\0${capStr}\n`));
  refs.forEach((r, i) => lines.push(pkt(i === 0 ? `${r.sha} ${r.name}\0${capStr}\n` : `${r.sha} ${r.name}\n`)));
  lines.push(FLUSH);
  return concat(...lines);
}

/** v0/v1 upload-pack advert filtered to HEAD + branch; a v2 capability advert passes unchanged. */
export function filterUploadAdvert(body: Uint8Array, branch: string): Uint8Array {
  const a = parseAdvert(body);
  if (!a) return body;
  const refs = a.refs.filter((r) => keepRef(r.name, branch));
  return renderAdvert(a.service, a.version1, refs, a.caps.filter((c) => !HIDDEN_WANT_CAPS.has(c)));
}

/** The receive-pack advert: the branch's ref (no HEAD, as git's receive-pack), our receive-pack caps. */
export function receiveAdvertFrom(uploadAdvert: Uint8Array, branch: string): Uint8Array {
  const a = parseAdvert(uploadAdvert);
  if (!a) throw new Error("expected a v0 upload-pack advertisement");
  const refs = a.refs.filter((r) => r.name === `refs/heads/${branch}`);
  const objectFormat = a.caps.filter((c) => c.startsWith("object-format="));
  return renderAdvert("git-receive-pack", false, refs, [...RECEIVE_PACK_CAPS, ...objectFormat, AGENT]);
}

/** A v2 `ls-refs` answer filtered to HEAD + branch (`<oid> <name> …` and `unborn <name> …` lines). */
export function filterLsRefs(body: Uint8Array, branch: string): Uint8Array {
  const out: Uint8Array[] = [];
  for (const p of parsePkts(body)) {
    if (p === "flush") {
      out.push(FLUSH);
      break;
    }
    if (typeof p === "string") continue;
    const name = pktText(p).split(" ")[1] ?? "";
    if (keepRef(name, branch)) out.push(pkt(p));
  }
  return concat(...out);
}

// ── v2 request parsing ──────────────────────────────────────────────────

/** Parse a protocol v2 command request, or null when it is not one. */
export function parseV2Command(body: Uint8Array): V2Command | null {
  let pkts: Pkt[];
  try {
    pkts = parsePkts(body);
  } catch {
    return null;
  }
  let command = "";
  const capabilities: string[] = [];
  const args: string[] = [];
  let inArgs = false;
  for (const p of pkts) {
    if (p === "flush" || p === "end") break;
    if (p === "delim") {
      inArgs = true;
      continue;
    }
    const line = pktText(p);
    if (inArgs) args.push(line);
    else if (line.startsWith("command=") && !command) command = line.slice("command=".length);
    else capabilities.push(line);
  }
  return command ? { command, capabilities, args } : null;
}

// ── handlers ────────────────────────────────────────────────────────────

/** GET info/refs for either service. */
export async function handleInfoRefs(t: ReadTarget, service: "git-upload-pack" | "git-receive-pack", req: Request): Promise<Response> {
  // The push advertisement is built from the v0 upload-pack one (read token only): never forward
  // `git-protocol` for it.
  const headers = service === "git-receive-pack" ? new Headers() : req.headers;
  const res = await upstreamFetch(t.deps, {
    hive: t.hive,
    repo: t.repo,
    scope: "read",
    endpoint: "info/refs",
    search: "?service=git-upload-pack",
    method: "GET",
    clientHeaders: headers,
    retry503: true,
  });
  if (res.status !== 200) return upstreamFailure(res, "info/refs", t);
  const body = new Uint8Array(await res.arrayBuffer());
  t.log.push(`info/refs ${service} proto=${req.headers.get("git-protocol") ?? "v0"}`);
  if (service === "git-receive-pack") return gitResponse(receiveAdvertFrom(body, t.branch), "application/x-git-receive-pack-advertisement");
  return gitResponse(filterUploadAdvert(body, t.branch), "application/x-git-upload-pack-advertisement");
}

async function readRequest(req: Request): Promise<{ raw: Uint8Array; plain: Uint8Array } | Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_REQUEST_BYTES) return new Response("QueenOS: fetch request too large\n", { status: 413 });
  const parts: Uint8Array[] = [];
  let n = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_UPLOAD_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return new Response("QueenOS: fetch request too large\n", { status: 413 });
      }
      parts.push(value);
    }
  }
  const raw = concat(...parts);
  if (!(req.headers.get("content-encoding") ?? "").includes("gzip")) return { raw, plain: raw };
  const s = new Response(raw).body!.pipeThrough(new DecompressionStream("gzip"));
  return { raw, plain: new Uint8Array(await new Response(s).arrayBuffer()) };
}

/** POST git-upload-pack. */
export async function handleUploadPack(t: ReadTarget, req: Request): Promise<Response> {
  const body = await readRequest(req);
  if (body instanceof Response) return body;
  const v2 = (req.headers.get("git-protocol") ?? "").includes("version=2");
  const cmd = v2 ? parseV2Command(body.plain) : null;
  t.log.push(`upload-pack ${cmd ? `v2 ${cmd.command}` : "v0/v1"}`);

  if (cmd?.command === "ls-refs" && t.notes?.handlers.isNotesLsRefs(cmd)) {
    try {
      const res = await t.notes.handlers.answerNotesLsRefs(t.notes.ctx, cmd);
      t.log.push("notes ls-refs answered by the proxy");
      return res;
    } catch (e) {
      // §9: notesFor failing means "no notes refs", never a wrong note.
      t.log.push(`notes ls-refs failed (${e instanceof Error ? e.message : String(e)}); answering no refs`);
      return gitResponse(FLUSH, UPLOAD_RESULT);
    }
  }
  if (cmd?.command === "fetch" && t.notes) {
    try {
      const res = await t.notes.handlers.answerNotesFetch(t.notes.ctx, cmd);
      if (res) {
        t.log.push("notes fetch answered by the proxy");
        return res;
      }
    } catch (e) {
      t.log.push(`notes fetch failed (${e instanceof Error ? e.message : String(e)}); forwarding upstream`);
    }
  }

  const res = await upstreamFetch(t.deps, {
    hive: t.hive,
    repo: t.repo,
    scope: "read",
    endpoint: "git-upload-pack",
    method: "POST",
    body: body.raw,
    clientHeaders: req.headers,
    headers: { "content-length": String(body.raw.length) },
    retry503: true,
  });
  if (res.status !== 200) return upstreamFailure(res, "git-upload-pack", t);
  if (cmd?.command === "ls-refs") {
    const filtered = filterLsRefs(new Uint8Array(await res.arrayBuffer()), t.branch);
    return gitResponse(filtered, UPLOAD_RESULT);
  }
  // The pack: streamed, never buffered.
  return gitResponse(res.body, res.headers.get("content-type") ?? UPLOAD_RESULT);
}

/** For tests and logs: the ref names a v0 advert or v2 ls-refs answer carries. */
export function advertisedRefs(body: Uint8Array): string[] {
  return parsePkts(body)
    .filter((p): p is Uint8Array => p instanceof Uint8Array)
    .map((p) => dec.decode(p).replace(/\n$/, "").split("\0")[0]!)
    .filter((l) => /^([0-9a-f]{40}|unborn) /.test(l))
    .map((l) => l.split(" ")[1]!);
}
