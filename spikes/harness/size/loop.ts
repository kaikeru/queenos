import { runToolLoop } from "../src/loop";
export default { fetch: (r: Request, env: Env) => runToolLoop({ env, model: "x", task: "x", base: {} }).then((x) => Response.json(x)) };
