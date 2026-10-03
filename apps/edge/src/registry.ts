import { DurableObject } from "cloudflare:workers";
import { HiveSlugSchema, type Project } from "@queenos/queen-types";

type Patch = { status?: Project["status"]; name?: string; description?: string; urls?: Partial<Project["urls"]> };

interface Row extends Record<string, SqlStorageValue> {
  hive: string;
  name: string;
  description: string;
  status: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  urls: string;
}

function toProject(r: Row): Project {
  return {
    hive: r.hive,
    name: r.name,
    description: r.description,
    status: r.status as Project["status"],
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    urls: JSON.parse(r.urls) as Project["urls"],
  };
}

/**
 * Project registry: one instance (idFromName("registry")). Orchestration
 * metadata only. Errors carry a code prefix: "CONFLICT:", "NOT_FOUND:", "INVALID:".
 */
export class HiveRegistry extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS projects (
      hive TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, urls TEXT NOT NULL)`);
  }

  private row(hive: string): Row | undefined {
    return this.ctx.storage.sql.exec<Row>("SELECT * FROM projects WHERE hive = ?", hive).toArray()[0];
  }

  async register(input: { hive: string; name: string; description: string; createdBy: string }): Promise<Project> {
    if (!HiveSlugSchema.safeParse(input.hive).success) throw new Error("INVALID: bad hive slug");
    const existing = this.row(input.hive);
    if (existing) {
      if (existing.created_by !== input.createdBy) throw new Error(`CONFLICT: hive ${input.hive} already exists`);
      return toProject(existing);
    }
    const t = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT INTO projects (hive, name, description, status, created_by, created_at, updated_at, urls) VALUES (?, ?, ?, 'ONBOARDING', ?, ?, ?, ?)",
      input.hive,
      input.name,
      input.description,
      input.createdBy,
      t,
      t,
      JSON.stringify({ prod: null, staging: null, preview: null }),
    );
    return toProject(this.row(input.hive)!);
  }

  async update(hive: string, patch: Patch): Promise<Project> {
    const cur = this.row(hive);
    if (!cur) throw new Error(`NOT_FOUND: hive ${hive}`);
    const urls = { ...(JSON.parse(cur.urls) as Project["urls"]), ...(patch.urls ?? {}) };
    this.ctx.storage.sql.exec(
      "UPDATE projects SET status = ?, name = ?, description = ?, urls = ?, updated_at = ? WHERE hive = ?",
      patch.status ?? cur.status,
      patch.name ?? cur.name,
      patch.description ?? cur.description,
      JSON.stringify(urls),
      Date.now(),
      hive,
    );
    return toProject(this.row(hive)!);
  }

  async list(): Promise<Project[]> {
    return this.ctx.storage.sql
      .exec<Row>("SELECT * FROM projects ORDER BY created_at DESC, hive ASC")
      .toArray()
      .map(toProject);
  }

  async get(hive: string): Promise<Project | null> {
    const r = this.row(hive);
    return r ? toProject(r) : null;
  }
}
