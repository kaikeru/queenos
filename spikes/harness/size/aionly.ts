import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
export default { fetch: async (r: Request, env: Env) => Response.json(await generateText({ model: createWorkersAI({ binding: env.AI })("x" as never), prompt: "x" })) };
