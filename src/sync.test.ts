import { test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import {
  bulkInsert,
  extractData,
  formatRev,
  get,
  getLeaves,
  getResolved,
  openStore,
  put,
  remove,
  replicate,
  revisionHash,
  type BulkDocument,
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

test("sync - one-way catch-up: A -> B replicates all writes", () => {
  const a = freshStore();
  const b = freshStore();
  put(a, { _id: "x", n: 1 });
  put(a, { _id: "y", s: "hello" });
  put(a, { _id: "z", t: true });

  const result = replicate(a, b, 0);
  deepStrictEqual(result.inserted, 3);
  deepStrictEqual(result.skipped, 0);
  deepStrictEqual(result.rejected, []);

  for (const id of ["x", "y", "z"]) {
    const da = get(a, id)!;
    const db = get(b, id)!;
    deepStrictEqual(db._rev, da._rev);
    deepStrictEqual(extractData(db), extractData(da));
  }
});

test("sync - re-replication is idempotent: empty pull, then full re-pull dedupes", () => {
  const a = freshStore();
  const b = freshStore();
  put(a, { _id: "x", n: 1 });
  put(a, { _id: "y", n: 2 });
  put(a, { _id: "z", n: 3 });

  const first = replicate(a, b, 0);
  deepStrictEqual(first.inserted, 3);

  const second = replicate(a, b, first.cursor);
  deepStrictEqual(second.inserted, 0);
  deepStrictEqual(second.skipped, 0);
  deepStrictEqual(second.cursor, first.cursor);

  const third = replicate(a, b, 0);
  deepStrictEqual(third.inserted, 0);
  deepStrictEqual(third.skipped, 3);
  deepStrictEqual(third.rejected, []);
});

test("sync - bidirectional convergence on disjoint ids", () => {
  const a = freshStore();
  const b = freshStore();
  put(a, { _id: "a1", n: 1 });
  put(a, { _id: "a2", n: 2 });
  put(b, { _id: "b1", n: 10 });
  put(b, { _id: "b2", n: 20 });

  replicate(a, b, 0);
  replicate(b, a, 0);

  for (const id of ["a1", "a2", "b1", "b2"]) {
    const da = get(a, id);
    const db = get(b, id);
    ok(da, `missing ${id} on A`);
    ok(db, `missing ${id} on B`);
    deepStrictEqual(da._rev, db._rev);
    deepStrictEqual(extractData(da), extractData(db));
  }
});

test("sync - concurrent edits produce a fork visible identically on both sides", () => {
  const a = freshStore();
  const b = freshStore();
  const g1 = put(a, { _id: "k", v: 0 });
  let aCursor = 0;
  const bCursor = 0;
  ({ cursor: aCursor } = replicate(a, b, aCursor));

  const childA = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, v: "A" });
  const childB = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, v: "B" });
  bulkInsert(a, [childA]);
  bulkInsert(b, [childB]);

  replicate(a, b, aCursor);
  replicate(b, a, bCursor);

  const ra = getResolved(a, "k")!;
  const rb = getResolved(b, "k")!;
  deepStrictEqual(getLeaves(a, "k").length, 2);
  deepStrictEqual(getLeaves(b, "k").length, 2);
  deepStrictEqual(ra.winner._rev, rb.winner._rev);
  deepStrictEqual([...ra.conflicts].sort(), [...rb.conflicts].sort());
  deepStrictEqual(ra.deletedConflicts, []);
  deepStrictEqual(rb.deletedConflicts, []);
});

test("sync - independent merges of the same fork converge to identical state", () => {
  const a = freshStore();
  const b = freshStore();
  const g1 = put(a, { _id: "k", v: 0 });
  let aCursor = 0;
  let bCursor = 0;
  ({ cursor: aCursor } = replicate(a, b, aCursor));

  const childA = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, v: "A" });
  const childB = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, v: "B" });
  bulkInsert(a, [childA]);
  bulkInsert(b, [childB]);
  ({ cursor: aCursor } = replicate(a, b, aCursor));
  ({ cursor: bCursor } = replicate(b, a, bCursor));

  const lastWriteWins: Reconciler = (leaves) => {
    const [winner] = leaves;
    return { _id: winner._id, ...extractData(winner) };
  };

  const mergedA = resolve(a, "k", lastWriteWins)!;
  const mergedB = resolve(b, "k", lastWriteWins)!;
  deepStrictEqual(mergedA._rev, mergedB._rev);

  replicate(a, b, aCursor);
  replicate(b, a, bCursor);

  for (const s of [a, b]) {
    const leaves = getLeaves(s, "k");
    const live = leaves.filter((l) => !l._deleted);
    deepStrictEqual(live.length, 1);
    deepStrictEqual(live[0]._rev, mergedA._rev);
    const r = getResolved(s, "k")!;
    deepStrictEqual(r.winner._rev, mergedA._rev);
    deepStrictEqual(r.conflicts, []);
    deepStrictEqual(r.deletedConflicts.length, 1);
  }
  const da = get(a, "k")!;
  const db = get(b, "k")!;
  deepStrictEqual(extractData(da), extractData(db));
});

test("sync - tombstones propagate", () => {
  const a = freshStore();
  const b = freshStore();
  const created = put(a, { _id: "x", n: 1 });
  remove(a, "x", created._rev);

  replicate(a, b, 0);

  const winner = get(b, "x")!;
  deepStrictEqual(winner._deleted, true);
  deepStrictEqual(winner._rev, get(a, "x")!._rev);
  const leaves = getLeaves(b, "x");
  deepStrictEqual(leaves.length, 1);
  deepStrictEqual(leaves[0]._deleted, true);
});
