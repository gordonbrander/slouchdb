import { test } from "node:test";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import {
  bulkInsert,
  extractData,
  formatRev,
  get,
  getLeaves,
  getWithConflicts,
  getRevision,
  openStore,
  put,
  revisionHash,
  type BulkDocument,
  type Document,
  type Store,
} from "./store.ts";
import { resolve, type Reconciler } from "./resolve.ts";

const freshStore = (): Store => openStore(":memory:");

type BuildDocInput = {
  _id: string;
  _parent?: string;
  _type?: string;
  _deleted?: boolean;
  _gen: number;
  [field: string]: unknown;
};

const buildDoc = (fields: BuildDocInput): BulkDocument => {
  const data = extractData(fields as Record<string, unknown>);
  const _deleted = fields._deleted ?? false;
  const hash = revisionHash({
    _id: fields._id,
    _gen: fields._gen,
    _parent: fields._parent,
    _type: fields._type,
    _deleted,
    data,
  });
  const { _gen, ...rest } = fields;
  void _gen;
  return { ...rest, _deleted, _rev: formatRev(fields._gen, hash) };
};

const lastWriteWins: Reconciler = (leaves) => {
  const [winner] = leaves;
  return { _id: winner._id, ...extractData(winner) };
};

test("resolve - missing doc returns undefined", () => {
  const store = freshStore();
  deepStrictEqual(resolve(store, "nope", lastWriteWins), undefined);
});

test("resolve - no conflict is a no-op: returns winner, leaf set unchanged", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const g2 = put(store, { _id: "k", n: 2, _parent: g1._rev });

  const before = getLeaves(store, "k").map((l) => l._rev);
  const out = resolve(store, "k", () => {
    throw new Error("reconcile should not run when there is no conflict");
  });
  ok(out);
  deepStrictEqual(out._rev, g2._rev);
  deepStrictEqual(
    getLeaves(store, "k").map((l) => l._rev),
    before,
  );
});

test("resolve - two-leaf conflict: merge under winner, loser tombstoned", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const a = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "A" });
  const b = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "B" });
  bulkInsert(store, [g1, a, b]);

  const before = getWithConflicts(store, "k");
  ok(before);
  deepStrictEqual(before.conflicts.length, 1);

  const merged = resolve(store, "k", (leaves) => ({
    _id: "k",
    merged: leaves.map((l) => l.branch as string),
  }));
  ok(merged);

  const live = getLeaves(store, "k").filter((l) => !l._deleted);
  deepStrictEqual(live.length, 1);
  deepStrictEqual(live[0]._rev, merged._rev);
  deepStrictEqual(merged._parent, before.winner._rev);

  // The merge revision is the new winner; the tombstones produced by
  // `resolve` show up as `deletedConflicts`, not as live conflicts.
  const after = getWithConflicts(store, "k");
  ok(after);
  deepStrictEqual(after.winner._rev, merged._rev);
  deepStrictEqual(after.conflicts, []);
  ok(after.deletedConflicts.length >= 1);

  // Loser has been tombstoned (a tombstone child of the loser exists)
  const loserRev = before.conflicts[0];
  const tombstones = getLeaves(store, "k").filter(
    (l) => l._deleted && l._parent === loserRev,
  );
  deepStrictEqual(tombstones.length, 1);
  // And that tombstone's _rev is in deletedConflicts
  ok(after.deletedConflicts.includes(tombstones[0]._rev));
});

test("resolve - reconciler sees [winner, ...losers] in deterministic order", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const a = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "A" });
  const b = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "B" });
  bulkInsert(store, [g1, a, b]);

  const before = getWithConflicts(store, "k");
  ok(before);

  let seen: readonly Document[] = [];
  resolve(store, "k", (leaves) => {
    seen = leaves;
    return { _id: "k", x: 1 };
  });

  deepStrictEqual(seen.length, 2);
  deepStrictEqual(seen[0]._rev, before.winner._rev);
  deepStrictEqual(
    seen.slice(1).map((l) => l._rev),
    before.conflicts,
  );
});

test("resolve - three-leaf conflict: one live leaf, two tombstones afterwards", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const a = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "A" });
  const b = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "B" });
  const c = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "C" });
  bulkInsert(store, [g1, a, b, c]);

  const before = getWithConflicts(store, "k");
  ok(before);
  deepStrictEqual(before.conflicts.length, 2);

  const merged = resolve(store, "k", () => ({ _id: "k", merged: true }));
  ok(merged);

  const leaves = getLeaves(store, "k");
  const live = leaves.filter((l) => !l._deleted);
  const dead = leaves.filter((l) => l._deleted);
  deepStrictEqual(live.length, 1);
  deepStrictEqual(live[0]._rev, merged._rev);
  deepStrictEqual(dead.length, 2);

  const tombstonedParents = new Set(dead.map((d) => d._parent));
  for (const losingRev of before.conflicts) {
    ok(tombstonedParents.has(losingRev));
  }
});

test("resolve - two replicas with the same reconciler produce identical merge _rev", () => {
  const a = freshStore();
  const b = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const left = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "L" });
  const right = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    branch: "R",
  });
  bulkInsert(a, [g1, left, right]);
  bulkInsert(b, [g1, left, right]);

  const reconcile: Reconciler = (leaves) => ({
    _id: "k",
    branches: leaves.map((l) => l.branch as string),
  });
  const ma = resolve(a, "k", reconcile);
  const mb = resolve(b, "k", reconcile);
  ok(ma);
  ok(mb);
  deepStrictEqual(ma._rev, mb._rev);
});

test("resolve - reconciler throw rolls back: leaf set unchanged, no merge or tombstones", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const a = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "A" });
  const b = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "B" });
  bulkInsert(store, [g1, a, b]);

  const before = getLeaves(store, "k")
    .map((l) => l._rev)
    .sort();

  throws(
    () =>
      resolve(store, "k", () => {
        throw new Error("reconcile-boom");
      }),
    /reconcile-boom/,
  );

  const after = getLeaves(store, "k")
    .map((l) => l._rev)
    .sort();
  deepStrictEqual(after, before);
});

test("resolve - reconciler returning a different _id is overridden", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const a = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "A" });
  const b = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "B" });
  bulkInsert(store, [g1, a, b]);

  const merged = resolve(store, "k", () => ({
    _id: "wrong",
    merged: true,
  }));
  ok(merged);
  deepStrictEqual(merged._id, "k");
  // No document with _id "wrong" should have been created
  deepStrictEqual(get(store, "wrong"), undefined);
});

test("resolve - merge revision is a child of the previous winner", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const a = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "A" });
  const b = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, branch: "B" });
  bulkInsert(store, [g1, a, b]);

  const before = getWithConflicts(store, "k");
  ok(before);
  const merged = resolve(store, "k", () => ({ _id: "k", merged: true }));
  ok(merged);

  deepStrictEqual(merged._parent, before.winner._rev);
  // The previous winner is no longer a leaf
  const stillLeaf = getLeaves(store, "k").some(
    (l) => l._rev === before.winner._rev,
  );
  deepStrictEqual(stillLeaf, false);
  // The previous winner is still in the tree (preserved history)
  ok(getRevision(store, before.winner._rev));
});

test("resolve - doc with only deleted conflicts (no live competitors) is a no-op", () => {
  const store = freshStore();
  // Live winner + tombstone sibling = no live conflict, just a deleted one.
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const live = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    v: "live",
  });
  const tomb = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    _deleted: true,
  });
  bulkInsert(store, [g1, live, tomb]);

  const before = getWithConflicts(store, "k");
  ok(before);
  deepStrictEqual(before.conflicts, []);
  deepStrictEqual(before.deletedConflicts, [tomb._rev]);

  const beforeLeaves = getLeaves(store, "k")
    .map((l) => l._rev)
    .sort();
  const out = resolve(store, "k", () => {
    throw new Error(
      "reconcile should not run when only deletedConflicts exist",
    );
  });
  ok(out);
  deepStrictEqual(out._rev, live._rev);

  const afterLeaves = getLeaves(store, "k")
    .map((l) => l._rev)
    .sort();
  deepStrictEqual(afterLeaves, beforeLeaves);
});
