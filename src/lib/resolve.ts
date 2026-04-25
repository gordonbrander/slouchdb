import { savepoint } from "./sqlite.ts";
import {
  getResolved,
  getRevisionBulk,
  put,
  remove,
  type Document,
  type PutInput,
  type Store,
} from "./store.ts";

/**
 * Computes the merged content of conflicting leaves. Receives all live
 * leaves in deterministic order: `[winner, ...losers]`. Returns a
 * {@link PutInput} carrying the merged user-data fields (and `_type` /
 * `_deleted` if applicable). The caller (`resolve`) overrides `_id` and
 * `_parent`.
 */
export type Reconciler = (leaves: readonly Document[]) => PutInput;

/**
 * Reconcile a multi-leaf conflict into a single live leaf. Reads the
 * current live leaves, calls `reconcile` on `[winner, ...liveLosers]`,
 * then atomically writes the merged document under the winner's branch
 * and tombstones every live losing leaf. Tombstone leaves
 * (`deletedConflicts`) are not touched — they're already capped branches
 * and don't compete for winner selection. Returns the merged document on
 * success, the existing winner unchanged when there are no live conflicts,
 * or `undefined` if `id` does not exist.
 *
 * Determinism: leaves are passed in canonical order
 * (`_deleted ASC, _rev_gen DESC, _rev_hash ASC`) and the merge is anchored
 * on the winner's `_rev`, so two replicas resolving with the same
 * reconciler produce identical merge revisions.
 */
export const resolve = (
  store: Store,
  id: string,
  reconcile: Reconciler,
): Document | undefined => {
  const r = getResolved(store, id);
  if (!r) return undefined;
  if (r.conflicts.length === 0) return r.winner;

  const losers = getRevisionBulk(store, r.conflicts).documents;

  return savepoint(store.db, "resolve", () => {
    const merged = put(store, {
      ...reconcile([r.winner, ...losers]),
      _id: id,
      _parent: r.winner._rev,
    });
    for (const loser of losers) {
      remove(store, id, loser._rev);
    }
    return merged;
  });
};
