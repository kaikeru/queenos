import { probeBundler } from "../src/bundle-probe";
export default { fetch: (r: Request, env: Env) => probeBundler(env).then((x) => Response.json(x)) };
