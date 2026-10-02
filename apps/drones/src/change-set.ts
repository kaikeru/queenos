/**
 * The builder LLM's output contract: a strict JSON file-change set.
 *
 * Local to drones for now; proposed as a queen-types addition
 * (`DroneChangeSetSchema`) once the dashboard wants to render it.
 */
import { z } from "zod";
import { assertRepoPath } from "@queenos/hive-kit";

/** Caps keep the `generate` step result far below the 1 MiB Workflows limit. */
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 512 * 1024;
export const MAX_PATH_CHARS = 200;
export const MAX_REASONING_STEPS = 20;
export const MAX_DISCARDED_PATHS = 50;
/** Reserved for the ledger fallback; the LLM may not write there. */
export const RESERVED_PREFIXES = [".queen/", ".git/"];

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

const RepoPath = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .transform((p, ctx) => {
    try {
      const clean = assertRepoPath(p);
      if (RESERVED_PREFIXES.some((r) => clean.startsWith(r))) {
        ctx.addIssue({ code: "custom", message: `path "${p}" is reserved` });
        return z.NEVER;
      }
      return clean;
    } catch {
      ctx.addIssue({ code: "custom", message: `unsafe path "${p}"` });
      return z.NEVER;
    }
  });

export const FileWriteSchema = z.object({
  path: RepoPath,
  content: z.string().refine((c) => byteLength(c) <= MAX_FILE_BYTES, `file exceeds ${MAX_FILE_BYTES} bytes`),
});

export const ChangeSetSchema = z
  .object({
    files: z.array(FileWriteSchema).min(1).max(MAX_FILES),
    reasoningSteps: z.array(z.string().max(2_000)).max(MAX_REASONING_STEPS).default([]),
    discardedPaths: z.array(z.string().max(MAX_PATH_CHARS)).max(MAX_DISCARDED_PATHS).default([]),
  })
  .superRefine((cs, ctx) => {
    const seen = new Set<string>();
    for (const f of cs.files) {
      if (seen.has(f.path)) ctx.addIssue({ code: "custom", message: `duplicate path "${f.path}"`, path: ["files"] });
      seen.add(f.path);
    }
    const total = cs.files.reduce((n, f) => n + byteLength(f.content), 0);
    if (total > MAX_TOTAL_BYTES) ctx.addIssue({ code: "custom", message: `change set exceeds ${MAX_TOTAL_BYTES} bytes`, path: ["files"] });
  });

export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export class ChangeSetError extends Error {
  override readonly name = "ChangeSetError";
}

/**
 * Pull the JSON object out of an LLM reply (tolerates ```json fences and
 * leading/trailing prose), then validate it.
 */
export function parseChangeSet(text: string): ChangeSet {
  const json = extractJsonObject(text);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new ChangeSetError(`change set is not valid JSON: ${(e as Error).message}`);
  }
  return validateChangeSet(raw);
}

export function validateChangeSet(raw: unknown): ChangeSet {
  const r = ChangeSetSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ChangeSetError(`invalid change set: ${issues}`);
  }
  return r.data;
}

function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ChangeSetError("no JSON object in model output");
  return body.slice(start, end + 1);
}
