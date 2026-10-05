/**
 * The seam to WP1.12's `mergeCar(ports, task, ts)` (src/merge.ts, owned by WP1.12).
 *
 * ASSUMED signature, from v2 design §2.3.4 / §8 row 1.12:
 *   mergeCar(ports: Pick<DronePorts, "artifacts" | "git">, task: DroneTask, timestamp: number): Promise<MergeResult>
 * It may return `trainId` (the car id) or leave it for us to fill in.
 *
 * WIRING: once src/merge.ts exports `mergeCar`, replace the body below with
 *   `import { mergeCar } from "./merge"; export const defaultMergeCar: MergeCarFn = mergeCar;`
 * Until then production MERGE fails fast with UNAVAILABLE (the drone reports `ok: false`); tests and the
 * Workflow integration inject `ports.mergeCar`.
 */
import type { MergeCarFn } from "./ports";

export const defaultMergeCar: MergeCarFn = async () => {
  throw new Error("UNAVAILABLE: mergeCar (src/merge.ts) is not wired into the drones yet");
};
