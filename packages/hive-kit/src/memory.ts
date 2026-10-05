/**
 * Hive memory over Vectorize (contract: @queenos/queen-types `memory.ts`).
 * The gatekeepers `remember()` one record per gate verdict; the Provisioner
 * `recall()`s the closest records for a train's prompt. Both take the slices
 * of the `Ai` and `VectorizeIndex` bindings they use, so tests pass fakes.
 */
import {
  MAX_MEMORY_TEXT,
  MAX_RECALLED_MEMORIES,
  MEMORY_EMBEDDING_MODEL,
  MIN_RECALL_SCORE,
  MemoryOutcomeSchema,
  MemoryRecordSchema,
  WORK_ITEM_VECTOR_KIND,
  type MemoryRecord,
  type RecalledMemory,
  type SimilarItem,
} from "@queenos/queen-types";
import type { AiRunner } from "./ai-gateway.js";

/** The slice of `VectorizeIndex` hive memory uses. */
export interface MemoryIndex {
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, string | number | boolean> }[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; filter?: Record<string, string>; returnMetadata?: "all" | "indexed" | "none" },
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> }[] }>;
}

export class MemoryError extends Error {
  override name = "MemoryError";
}

/** The memory id for a gated head: one memory per (train, commit). */
export function memoryIdFor(trainId: string, commitSha: string): string {
  return `${trainId}:${commitSha.slice(0, 12)}`;
}

/** Clip to `n` chars with an ellipsis. */
function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * The embedded text of a memory: prompt, builder reasoning, changed files,
 * verdict. Kept under MAX_MEMORY_TEXT so it fits a drone prompt as-is.
 */
export function composeMemoryText(input: {
  promptText: string;
  outcome: MemoryRecord["outcome"];
  verdict: string;
  reasoning?: string[];
  changedFiles?: string[];
}): string {
  const label = { PASSED: "passed the gate", FAILED: "failed the gate", REJECTED_BY_REVIEW: "was rejected by the reviewer" }[input.outcome];
  const parts = [`Prompt: ${clip(input.promptText.replace(/\s+/g, " ").trim(), 300)}`];
  if (input.changedFiles?.length) parts.push(`Changed: ${clip(input.changedFiles.slice(0, 12).join(", "), 200)}`);
  if (input.reasoning?.length) parts.push(`Builder: ${clip(input.reasoning.slice(0, 6).join("; "), 300)}`);
  parts.push(`Outcome: ${label}. ${input.verdict.replace(/\s+/g, " ").trim()}`);
  return clip(parts.join("\n"), MAX_MEMORY_TEXT);
}

export class HiveMemory {
  constructor(
    private readonly ai: AiRunner | undefined,
    private readonly index: MemoryIndex | undefined,
  ) {}

  private async embed(texts: string[]): Promise<number[][]> {
    if (!this.ai || !this.index) throw new MemoryError("UNAVAILABLE: AI / MEMORY binding is not configured");
    const res = (await this.ai.run(MEMORY_EMBEDDING_MODEL, { text: texts })) as { data?: number[][] };
    if (!res?.data || res.data.length !== texts.length) throw new MemoryError("embedding model returned an unexpected shape");
    return res.data;
  }

  /** Embed and upsert one memory (idempotent per memoryId). */
  async remember(record: MemoryRecord): Promise<void> {
    const r = MemoryRecordSchema.parse(record);
    const [values] = await this.embed([r.text]);
    await this.index!.upsert([
      {
        id: r.memoryId,
        values: values!,
        metadata: {
          namespace: r.namespace,
          trainId: r.trainId,
          promptId: r.promptId,
          commitSha: r.commitSha,
          outcome: r.outcome,
          promptText: r.promptText,
          text: r.text,
          createdAt: r.createdAt,
        },
      },
    ]);
  }

  /**
   * The closest memories in `namespace` for `query`, best first. Drops
   * matches under MIN_RECALL_SCORE, malformed metadata and memories from
   * `excludeTrainId` (a train must not recall itself).
   */
  async recall(namespace: string, query: string, opts: { topK?: number; excludeTrainId?: string } = {}): Promise<RecalledMemory[]> {
    const topK = Math.min(opts.topK ?? MAX_RECALLED_MEMORIES, MAX_RECALLED_MEMORIES);
    const [vector] = await this.embed([clip(query, 2_000)]);
    // Over-fetch: the self-train, work-item vectors (they share the index) and low scores are filtered out below.
    const res = await this.index!.query(vector!, { topK: Math.min(topK + 10, 20), filter: { namespace }, returnMetadata: "all" });
    const out: RecalledMemory[] = [];
    for (const m of res.matches) {
      if (m.score < MIN_RECALL_SCORE) continue;
      const md = m.metadata ?? {};
      if (md.kind === WORK_ITEM_VECTOR_KIND) continue;
      const outcome = MemoryOutcomeSchema.safeParse(md.outcome);
      if (!outcome.success || typeof md.text !== "string" || typeof md.trainId !== "string" || typeof md.promptId !== "string") continue;
      if (opts.excludeTrainId && md.trainId === opts.excludeTrainId) continue;
      out.push({
        memoryId: m.id,
        trainId: md.trainId,
        promptId: md.promptId,
        outcome: outcome.data,
        promptText: typeof md.promptText === "string" ? md.promptText.slice(0, 300) : "",
        text: md.text.slice(0, MAX_MEMORY_TEXT),
        createdAt: typeof md.createdAt === "number" ? md.createdAt : 0,
        score: m.score,
      });
      if (out.length >= topK) break;
    }
    return out;
  }

  /**
   * For each text, the closest work-item vectors in `namespace` (best first),
   * as `{itemId, score}`. Filters on `kind = work-item` (needs the `kind`
   * metadata index). Ids in `excludeIds` are dropped (an item must not match
   * itself). Throws on trouble; the Oracle treats that as "no similar items".
   */
  async findSimilarItems(
    namespace: string,
    texts: string[],
    opts: { topK?: number; minScore?: number; excludeIds?: string[] } = {},
  ): Promise<SimilarItem[][]> {
    if (texts.length === 0) return [];
    const topK = Math.min(opts.topK ?? 5, 10);
    const exclude = new Set(opts.excludeIds ?? []);
    const vectors = await this.embed(texts.map((t) => clip(t, 2_000)));
    const out: SimilarItem[][] = [];
    for (const v of vectors) {
      const res = await this.index!.query(v, {
        topK: Math.min(topK + exclude.size, 20),
        filter: { namespace, kind: WORK_ITEM_VECTOR_KIND },
        returnMetadata: "all",
      });
      const items: SimilarItem[] = [];
      for (const m of res.matches) {
        if (exclude.has(m.id) || m.score < (opts.minScore ?? 0)) continue;
        const md = m.metadata ?? {};
        items.push({ itemId: typeof md.itemId === "string" ? md.itemId : m.id, score: m.score });
        if (items.length >= topK) break;
      }
      out.push(items);
    }
    return out;
  }

  /**
   * Embed and upsert work-item vectors (id = the item id or `<goalId>-c<n>`;
   * idempotent). Metadata carries `kind = work-item` so gate memories never
   * mix with them.
   */
  async indexItems(namespace: string, items: { id: string; text: string; title?: string }[]): Promise<void> {
    if (items.length === 0) return;
    const vectors = await this.embed(items.map((i) => clip(i.text, 2_000)));
    await this.index!.upsert(
      items.map((it, n) => ({
        id: it.id,
        values: vectors[n]!,
        metadata: {
          namespace,
          kind: WORK_ITEM_VECTOR_KIND,
          itemId: it.id,
          title: clip(it.title ?? it.text, 120),
          createdAt: Date.now(),
        },
      })),
    );
  }
}
