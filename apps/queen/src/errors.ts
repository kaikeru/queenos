/** Structural view of a zod schema (avoids a direct zod dependency here). */
export interface Schema<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}
type Issues = ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;

export type QueenErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE";

const STATUS: Record<QueenErrorCode, 400 | 404 | 409 | 503> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAVAILABLE: 503,
};

/**
 * Typed Queen error. Workers RPC only carries `name` and `message` across the
 * stub boundary, so the code is encoded as a `CODE: detail` message prefix and
 * revived on the caller side with {@link asQueenError}.
 */
export class QueenError extends Error {
  override readonly name = "QueenError";

  constructor(
    readonly code: QueenErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }

  get status(): 400 | 404 | 409 | 503 {
    return STATUS[this.code];
  }

  static invalid(what: string, issues: Issues): QueenError {
    const detail = issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
    return new QueenError("INVALID_INPUT", `invalid ${what}: ${detail}`);
  }
}

const PREFIX = /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): ([\s\S]*)$/;

/** Revive a QueenError thrown locally or across a DO RPC stub. */
export function asQueenError(e: unknown): QueenError | null {
  if (e instanceof QueenError) return e;
  if (e instanceof Error) {
    const m = PREFIX.exec(e.message);
    if (m) return new QueenError(m[1] as QueenErrorCode, m[2]!);
  }
  return null;
}

/** Parse with a zod schema or throw INVALID_INPUT. */
export function parseOrThrow<T>(schema: Schema<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw QueenError.invalid(what, r.error.issues);
  return r.data;
}
