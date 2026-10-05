import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import type { MapWorkspace } from "./workspace";
import { verifyWorker, type VerifyResult } from "./verify";

export interface FinishArgs {
  summary: string;
  reasoningSteps: string[];
}

export function droneTools(ws: MapWorkspace, loader: WorkerLoader | undefined, onVerify?: (r: VerifyResult) => void): ToolSet {
  const wsTools = createWorkspaceTools(ws as never, { bash: false });
  return {
    read: wsTools.read,
    write: wsTools.write,
    edit: wsTools.edit,
    list: wsTools.list,
    find: wsTools.find,
    grep: wsTools.grep,
    delete: wsTools.delete,
    verify: tool({
      description:
        "Load the current workspace as a Worker in an isolated sandbox (no network) and GET the given paths. Returns status, content-type and the start of each body. Always includes / and /health.",
      inputSchema: z.object({ paths: z.array(z.string()).max(5).optional().describe("Extra paths to fetch, e.g. /features/foo") }),
      execute: async ({ paths }) => {
        if (!loader) return { error: "verify unavailable (no Worker Loader binding)" };
        const r = await verifyWorker(loader, ws.snapshot(), [...new Set(["/", "/health", ...(paths ?? [])])]);
        onVerify?.(r);
        return r;
      },
    }),
    finish: tool({
      description: "Call once when the change is done and verified. Ends the task.",
      inputSchema: z.object({
        summary: z.string().max(500),
        reasoningSteps: z.array(z.string().max(300)).min(1).max(6),
      }),
      execute: async () => ({ ok: true }),
    }),
  };
}
