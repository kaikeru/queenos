/** Where an attempt's clone lives on the agent's disk (the server never touches it). */
export const attemptDir = (attemptId: string): string => `.queenos/attempts/${attemptId}`;

/** The token goes in the clone's local http.extraHeader, never in the remote URL, never a global helper. */
export function cloneCommand(remote: string, token: string, dir: string): string {
  return `git -c http.extraHeader="Authorization: Bearer ${token}" clone ${remote} ${dir}`;
}

export function configCommand(remote: string, token: string, dir: string): string {
  return `git -C ${dir} config --local --replace-all http.${remote}.extraHeader "Authorization: Bearer ${token}"`;
}

export const cleanupOf = (attemptId: string): string => `remove ${attemptDir(attemptId)}`;

export const GIT_NOTE =
  "Run cloneCommand, then configCommand. Never set a global credential helper or a global http.extraHeader. Commit, then `git push origin main`; call wait({attemptId, until: \"verdict\"}). Before the token expires, refresh_attempt and run its configCommand.";
