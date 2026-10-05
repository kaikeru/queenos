/**
 * The MERGE seam: `runMerge` (orchestrate.ts) calls `ports.mergeCar ?? defaultMergeCar`.
 * The default is WP1.12's `mergeCar` (src/merge.ts); tests may inject their own.
 */
import { mergeCar } from "./merge";
import type { MergeCarFn } from "./ports";

export const defaultMergeCar: MergeCarFn = mergeCar;
