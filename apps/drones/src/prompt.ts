/** Builder prompt assembly for the live LLM path. */
import type { DroneTask } from "@queenos/queen-types";
import type { ChatMessage } from "@queenos/hive-kit";
import { MAX_FILE_BYTES, MAX_FILES } from "./change-set";

export const BUILDER_SYSTEM_PROMPT = `You are a QueenOS builder drone. You implement one user request as a small, self-contained change to a Git repository that is shared by many concurrent agents in a speculative merge train.

Output ONLY a single JSON object, no prose and no Markdown fences, with exactly this shape:
{"files":[{"path":"relative/path.ext","content":"full new file content"}],"reasoningSteps":["short step"],"discardedPaths":["path or approach you considered and rejected"]}

Rules:
- "files" holds complete file contents (not diffs). At most ${MAX_FILES} files, each under ${MAX_FILE_BYTES} bytes.
- Paths are relative to the repo root. Never write under .git/ or .queen/.
- Prefer additive changes (new files) over edits to shared files, so other trains stay mergeable.
- "reasoningSteps" is a compact audit trail (at most 8 short sentences). It is stored in the Cognitive Ledger.
- "discardedPaths" lists alternatives you rejected, briefly.`;

const MAX_RAG_SNIPPETS = 8;
const MAX_RAG_CHARS = 2_000;

export function buildBuilderMessages(
  task: Pick<DroneTask, "promptText" | "action" | "ragContext" | "scribeSummary">,
  repoFiles: string[] = [],
): ChatMessage[] {
  const parts: string[] = [];
  if (repoFiles.length) {
    parts.push(`<repo_files>\n${repoFiles.slice(0, 200).join("\n")}\n</repo_files>`);
  }
  const rag = task.ragContext.slice(0, MAX_RAG_SNIPPETS).map((s) => s.slice(0, MAX_RAG_CHARS));
  if (rag.length) {
    parts.push(`<hive_memory>\n${rag.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")}\n</hive_memory>`);
  }
  if (task.action === "REWORK" && task.scribeSummary) {
    parts.push(
      `<previous_failure>\nThe previous attempt at this request was rejected by the gatekeepers. Scribe summary:\n${task.scribeSummary}\nFix the cause; do not repeat the same change.\n</previous_failure>`,
    );
  }
  parts.push(`<request>\n${task.promptText}\n</request>`);
  return [{ role: "user", content: parts.join("\n\n") }];
}
