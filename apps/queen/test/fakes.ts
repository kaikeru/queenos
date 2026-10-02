import type { DroneTask } from "@queenos/queen-types";
import type { ForkProvisioner, ForkResult } from "../src/artifacts";
import type { DroneDispatcher } from "../src/drones";

/** In-memory Artifacts stand-in (tests run with remoteBindings: false). */
export class FakeForkProvisioner implements ForkProvisioner {
  readonly forks: { source: string; name: string }[] = [];
  readonly deleted: string[] = [];
  readonly live = new Set<string>();

  async forkTrain(source: string, name: string): Promise<ForkResult> {
    this.forks.push({ source, name });
    this.live.add(name);
    return { artifactRepo: name, baseSha: `sha-of-${source}` };
  }

  async deleteFork(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.live.delete(name);
  }
}

export class RecordingDispatcher implements DroneDispatcher {
  readonly tasks: DroneTask[] = [];

  async dispatch(task: DroneTask): Promise<{ instanceId: string }> {
    this.tasks.push(task);
    return { instanceId: `${task.trainId}-${task.action}` };
  }
}
