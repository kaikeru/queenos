/** Where an attempt's clone lives on the agent's disk (the server never touches it). */
export const attemptDir = (attemptId: string): string => `.queenos/attempts/${attemptId}`;

/** The token goes in the clone's local http.extraHeader, never in the remote URL, never a global helper. */
export function configCommand(remote: string, token: string, dir: string): string {
  return `git -C ${dir} config --local --replace-all http.${remote}.extraHeader "Authorization: Bearer ${token}"`;
}

/** One command that creates the clone: the token appears exactly once (init, set the header, then fetch with it). */
export function setupCommand(remote: string, token: string, dir: string): string {
  return [`git init ${dir}`, configCommand(remote, token, dir), `git -C ${dir} remote add origin ${remote}`, `git -C ${dir} fetch origin main`, `git -C ${dir} checkout -b main FETCH_HEAD`].join(" && ");
}

export const cleanupOf = (attemptId: string): string => `remove ${attemptDir(attemptId)}`;

export const GIT_NOTE =
  "Run setupCommand once (it creates the clone with the token in its local git config only). Never set a global credential helper or a global http.extraHeader. Commit, then `git push origin main`; call wait({attemptId, until: \"verdict\"}). Before the token expires, refresh_attempt and run its configCommand.";
