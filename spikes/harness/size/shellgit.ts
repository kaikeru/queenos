import { loadRepoTree } from "../src/repo";
export default { fetch: (r: Request, env: Env) => loadRepoTree(env.ARTIFACTS, "x").then((x) => Response.json(x)) };
