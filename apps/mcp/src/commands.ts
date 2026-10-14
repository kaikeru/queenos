import { ToolError } from "./errors";

/** Where an attempt's clone lives on the agent's disk (the server never touches it). */
export const attemptDir = (attemptId: string): string => `.queenos/attempts/${attemptId}`;

const REMOTE_OK = /^https:\/\/[A-Za-z0-9.:/_-]+$/;
const TOKEN_OK = /^[A-Za-z0-9._~?=&+/-]+$/;
/** POSIX single-quote: nothing inside is interpreted by the shell. */
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Defense in depth: both values come from Artifacts, but they end up inside a shell command the agent runs. */
function checked(remote: string, token: string): void {
  if (!REMOTE_OK.test(remote) || !TOKEN_OK.test(token)) throw new ToolError("ARTIFACTS_UNAVAILABLE", "Artifacts returned an unexpected remote or token format; retry", { retryAfterMs: 5000 });
}

/** The token goes in the clone's local http.extraHeader, never in the remote URL, never a global helper. */
export function configCommand(remote: string, token: string, dir: string): string {
  checked(remote, token);
  return `git -C ${sq(dir)} config --local --replace-all ${sq(`http.${remote}.extraHeader`)} ${sq(`Authorization: Bearer ${token}`)}`;
}

/** One command that creates the clone: the token appears exactly once (init, set the header, then fetch with it). */
export function setupCommand(remote: string, token: string, dir: string): string {
  const d = sq(dir);
  return [`git init ${d}`, configCommand(remote, token, dir), `git -C ${d} remote add origin ${sq(remote)}`, `git -C ${d} fetch origin main`, `git -C ${d} checkout -b main FETCH_HEAD`].join(" && ");
}

export const cleanupOf = (attemptId: string): string => `remove ${attemptDir(attemptId)}`;

export const GIT_NOTE =
  "Run setupCommand once (it creates the clone with the token in its local git config only). Never set a global credential helper or a global http.extraHeader. Commit, then `git push origin main`; call wait({attemptId, until: \"verdict\"}). Before the token expires, refresh_attempt and run its configCommand.";

const SHA_OK = /^[0-9a-f]{40}$/;

/**
 * `sync_base` (rework-loop spec 6.1): one `&&` chain that (re)adds a read-only `queen` remote for hive main, sets its read
 * token in the clone's local config (the token appears only here; `--replace-all` rotates it on a rerun), fetches main
 * as refs/remotes/queen/main, and fails loudly when main moved after the read. Fetch only: the rebase is the agent's.
 */
export function syncCommand(hiveRemote: string, readToken: string, baseSha: string, dir: string): string {
  const header = configCommand(hiveRemote, readToken, dir); // validates remote and token
  if (!SHA_OK.test(baseSha)) throw new ToolError("ARTIFACTS_UNAVAILABLE", "reading the hive's main failed; retry sync_base", { retryAfterMs: 5000 });
  const d = sq(dir);
  return [
    `(git -C ${d} remote remove queen || true)`,
    `git -C ${d} remote add queen ${sq(hiveRemote)}`,
    header,
    `git -C ${d} fetch queen +main:refs/remotes/queen/main`,
    `{ test "$(git -C ${d} rev-parse refs/remotes/queen/main)" = ${sq(baseSha)} || { echo ${sq("main moved; call sync_base again")} >&2; false; }; }`,
  ].join(" && ");
}

/** What to do after `syncCommand` (6.1 `next`). */
export const syncNext = (dir: string): string =>
  `Rebase onto queen/main (git -C ${sq(dir)} rebase queen/main), resolve conflicts keeping both behaviours, run the tests, then git -C ${sq(dir)} push --force-with-lease origin HEAD:main.`;
