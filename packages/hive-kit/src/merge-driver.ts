/**
 * The merge queue's merge driver (v2 design §2.3.4). For paths in
 * GENERATED_PATHS (the feature registry) it merges by module set:
 * `renderRegistry(ours ∪ theirs − removedInEither)` computed from the base,
 * ours and theirs module lists, so two features that both register never
 * conflict. Every other path falls back to isomorphic-git's built-in diff3.
 * The agent equivalent of `.gitattributes merge=union`.
 *
 * WP0 seam; WP1.12 implements it (with tests on real isomorphic-git over memfs).
 */
import type { MergeDriverCallback } from "isomorphic-git";

/**
 * Three-way merge of registry contents by module set (pure). Modules removed
 * on either side stay removed; additions from both sides are kept.
 */
export function mergeRegistryContents(base: string, ours: string, theirs: string): string {
  void base;
  void ours;
  void theirs;
  throw new Error("not implemented");
}

/** isomorphic-git `mergeDriver`: the registry merge for GENERATED_PATHS, diff3 for everything else. */
export const registryMergeDriver: MergeDriverCallback = (args) => {
  void args;
  throw new Error("not implemented");
};
