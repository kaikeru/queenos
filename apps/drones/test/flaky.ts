/** Fault injection for the MERGE / LAND network calls: the first N calls of an operation fail with a 503. */
import type { DronePorts, GitSession } from "../src/ports";

export const http503 = () => Object.assign(new Error("HTTP Error: 503 Service Unavailable"), { name: "HttpError" });

export type FlakyOp = "access" | "clone" | "fetchRef" | "push" | "deepen";

export class Flaky {
  readonly calls: Record<FlakyOp, number> = { access: 0, clone: 0, fetchRef: 0, push: 0, deepen: 0 };
  constructor(private readonly failFirst: Partial<Record<FlakyOp, number>>) {}

  private hit(op: FlakyOp): void {
    this.calls[op]++;
    if (this.calls[op] <= (this.failFirst[op] ?? 0)) throw http503();
  }

  wrap(ports: Pick<DronePorts, "artifacts" | "git">): Pick<DronePorts, "artifacts" | "git"> {
    return {
      artifacts: { access: async (repo, scope) => (this.hit("access"), ports.artifacts.access(repo, scope)) },
      git: {
        clone: async (req) => {
          this.hit("clone");
          const repo = await ports.git.clone(req);
          const hit = (op: FlakyOp) => this.hit(op);
          return new Proxy(repo, {
            get(target, prop, recv) {
              const v = Reflect.get(target, prop, target) as unknown;
              if ((prop === "push" || prop === "fetchRef" || prop === "deepen") && typeof v === "function") {
                return (...args: unknown[]) => (hit(prop), (v as (...a: unknown[]) => unknown).apply(target, args));
              }
              void recv;
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          }) as GitSession;
        },
      },
    };
  }
}

/** No real waiting; records the delays. */
export const fastNet = (attempts = 3) => {
  const sleeps: number[] = [];
  return { sleeps, net: { attempts, random: () => 0.5, sleep: async (ms: number) => void sleeps.push(ms) } };
};
