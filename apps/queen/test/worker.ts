/**
 * Test entrypoint (vitest.config.ts `main`). Same Worker, but QueenNode gets
 * recording executor / drone ports through the createPorts() constructor seam.
 * `SimQueenNode` (binding SIM_QUEEN, v2-flow.test.ts) runs the real sim ports instead.
 */
import { QueenNode as ProdQueenNode, type QueenPorts } from "../src/queen-node";
import { RACE_MARKER, SimExecutors, type SimDelays } from "../src/sim/sim-ports";
import { RecordingDispatcher, RecordingHerald, RecordingOracle, RecordingProvisioner, RecordingSentinel } from "./fakes";

export { default } from "../src/index";
export { SwarmGovernor } from "../src/scale/governor";

export class QueenNode extends ProdQueenNode {
  /** Skews the planner/watchdog clock (tests set it via runInDurableObject). */
  clockOffset = 0;

  protected override now(): number {
    return Date.now() + this.clockOffset;
  }

  protected override createPorts(): QueenPorts {
    return {
      provisioner: new RecordingProvisioner(),
      herald: new RecordingHerald(),
      sentinel: new RecordingSentinel(),
      oracle: new RecordingOracle(),
      dispatcher: new RecordingDispatcher(),
    };
  }
}

/** Fast sim timings for the e2e tests (the fakes still run off the DO alarm). */
export const E2E_DELAYS: SimDelays = {
  fork: 5,
  delete: 5,
  deploy: 10,
  teardown: 5,
  build: 30,
  test: 20,
  land: 10,
  sentinel: 10,
  merge: 10,
  oracleDecompose: 10,
  oracleTriage: 5,
  buildJitter: { min: 20, max: 80 },
};

/**
 * The sim Queen (src/sim/worker.ts) with fast delays, driven by tests through
 * `runDurableObjectAlarm`. Two test holds shape timing deterministically
 * (bisect scenario): `holdCarForks` parks the FORK of every merge-queue car,
 * and `holdText` parks BUILD drones whose prompt contains it, until `releaseHolds()`.
 */
export class SimQueenNode extends ProdQueenNode {
  private declare sim: SimExecutors | undefined;
  declare holdCarForks: boolean | undefined;
  declare holdText: string | null | undefined;
  private declare held: { kind: "car" | "text"; run: () => Promise<unknown> }[] | undefined;

  protected override isSim(): boolean {
    return true;
  }

  protected override createPorts(): QueenPorts {
    const sim = new SimExecutors(() => this, this.ctx.storage, E2E_DELAYS);
    this.sim = sim;
    const park = (kind: "car" | "text", run: () => Promise<unknown>) => {
      (this.held ??= []).push({ kind, run });
    };
    return {
      provisioner: {
        dispatch: async (c) => {
          if (this.holdCarForks && c.op === "FORK" && this.sql.exec("SELECT lane FROM merge_trains WHERE train_id = ?", c.trainId).toArray()[0]?.lane === "QUEUE") {
            park("car", () => sim.provisioner.dispatch(c));
            return { instanceId: c.commandId };
          }
          return sim.provisioner.dispatch(c);
        },
      },
      herald: sim.herald,
      sentinel: sim.sentinel,
      oracle: sim.oracle,
      dispatcher: {
        dispatch: async (task, attempt) => {
          if (this.holdText && task.action === "BUILD" && task.promptText.includes(this.holdText)) {
            park("text", () => sim.drones.dispatch(task, attempt));
            return { instanceId: `${task.trainId}-held` };
          }
          return sim.drones.dispatch(task, attempt);
        },
      },
    };
  }

  /** Set or clear the holds; clearing one runs what it parked. Returns the number released. */
  async setHolds(h: { carForks?: boolean; text?: string | null }): Promise<number> {
    if (h.carForks !== undefined) this.holdCarForks = h.carForks;
    if (h.text !== undefined) this.holdText = h.text;
    const all = this.held ?? [];
    const go = all.filter((x) => (x.kind === "car" ? !this.holdCarForks : !this.holdText));
    this.held = all.filter((x) => !go.includes(x));
    for (const x of go) await x.run();
    return go.length;
  }

  protected override filingHints(text: string): { bestOf?: number } {
    return text.includes(RACE_MARKER) ? { bestOf: 3 } : {};
  }

  /** Jobs due by now (the sim's job queue), for tests that step the alarm. */
  override async alarm(): Promise<void> {
    await this.sim?.runDue();
    await super.alarm();
  }
}
