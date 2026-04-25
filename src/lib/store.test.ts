import { test } from "node:test";
import { deepStrictEqual, ok, throws } from "node:assert/strict";
import {
  bulkInsert,
  changesSince,
  closeStore,
  extractData,
  formatRev,
  get,
  getHistory,
  getLeaves,
  getResolved,
  getRevision,
  getRevisionBulk,
  openStore,
  parseRev,
  put,
  remove,
  revisionHash,
  type BulkDocument,
  type Store,
} from "./store.ts";
import { ConflictError } from "./errors.ts";

const freshStore = (): Store => openStore(":memory:");

type BuildDocInput = {
  _id: string;
  _parent?: string;
  _type?: string;
  _deleted?: boolean;
  _gen: number;
  [field: string]: unknown;
};

/** Construct a BulkDocument with a correctly computed `_rev`. */
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

test("parseRev / formatRev - round-trip and reject malformed input", () => {
  const rev = formatRev(7, "abcdef");
  deepStrictEqual(rev, "7-abcdef");
  const parsed = parseRev(rev);
  deepStrictEqual(parsed.gen, 7);
  deepStrictEqual(parsed.hash, "abcdef");

  throws(() => parseRev("no-dash-start"));
  throws(() => parseRev("-leadingdash"));
  throws(() => parseRev("notanumber-hash"));
  throws(() => parseRev("0-zerogen"));
  throws(() => parseRev("1.5-frac"));
});

test("openStore - creates schema and close works", () => {
  const store = freshStore();
  const doc = put(store, { _id: "a", n: 1 });
  deepStrictEqual(parseRev(doc._rev).gen, 1);
  closeStore(store);
});

test("put - genesis write: gen 1 in _rev, no parent, _rev matches, _local_seq 1, data inlined", () => {
  const store = freshStore();
  const doc = put(store, { _id: "doc", hello: "world" });
  deepStrictEqual(doc._id, "doc");
  deepStrictEqual(parseRev(doc._rev).gen, 1);
  ok(doc._rev.startsWith("1-"));
  deepStrictEqual(doc._parent, undefined);
  deepStrictEqual(doc._deleted, false);
  deepStrictEqual(doc._type, undefined);
  deepStrictEqual(doc._local_seq, 1);
  deepStrictEqual(doc.hello, "world");
  const expectedHash = revisionHash({
    _id: "doc",
    _gen: 1,
    _parent: undefined,
    _type: undefined,
    _deleted: false,
    data: { hello: "world" },
  });
  deepStrictEqual(doc._rev, formatRev(1, expectedHash));
});

test("put - linear extension bumps gen; previous rev is no longer a leaf", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const g2 = put(store, { _id: "k", n: 2, _parent: g1._rev });

  deepStrictEqual(parseRev(g2._rev).gen, 2);
  deepStrictEqual(g2._parent, g1._rev);

  const leaves = getLeaves(store, "k");
  deepStrictEqual(leaves.length, 1);
  deepStrictEqual(leaves[0]._rev, g2._rev);
});

test("put - missing _parent when a leaf exists throws ConflictError", () => {
  const store = freshStore();
  put(store, { _id: "k", n: 1 });
  throws(() => put(store, { _id: "k", n: 2 }), ConflictError);
});

test("put - stale _parent (pointing to former leaf) throws ConflictError", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  put(store, { _id: "k", n: 2, _parent: g1._rev });
  throws(() => put(store, { _id: "k", n: 3, _parent: g1._rev }), ConflictError);
});

test("put - genesis put with a _parent that does not exist throws ConflictError", () => {
  const store = freshStore();
  throws(
    () => put(store, { _id: "k", n: 1, _parent: "1-nonexistentrev" }),
    ConflictError,
  );
});

test("put - is idempotent when called twice with identical content+parent", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const a = put(store, { _id: "k", n: 2, _parent: g1._rev });
  const b = put(store, { _id: "k", n: 2, _parent: g1._rev });
  deepStrictEqual(a._rev, b._rev);
  deepStrictEqual(a._local_seq, b._local_seq);
  const all = changesSince(store, 0);
  deepStrictEqual(all.length, 2);
});

test("put - non-reserved `_`-prefixed fields pass through into user data", () => {
  const store = freshStore();
  const doc = put(store, { _id: "x", _custom: "keep", regular: 1 });
  deepStrictEqual(doc._custom, "keep");
  deepStrictEqual(doc.regular, 1);
  const other = put(store, { _id: "y", _custom: "diff", regular: 1 });
  ok(doc._rev !== other._rev);
});

test("remove - produces a tombstone that stays in the leaf set", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const tomb = remove(store, "k", g1._rev);
  deepStrictEqual(tomb._deleted, true);
  deepStrictEqual(parseRev(tomb._rev).gen, 2);
  deepStrictEqual(tomb._parent, g1._rev);

  const leaves = getLeaves(store, "k");
  deepStrictEqual(leaves.length, 1);
  deepStrictEqual(leaves[0]._rev, tomb._rev);
});

test("get - returns the tombstone when every leaf is deleted", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  remove(store, "k", g1._rev);
  const winner = get(store, "k");
  ok(winner);
  deepStrictEqual(winner._deleted, true);
});

test("get - returns undefined for an unknown _id", () => {
  const store = freshStore();
  deepStrictEqual(get(store, "nope"), undefined);
});

test("getRevision - returns a specific rev by _rev regardless of leaf status", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  put(store, { _id: "k", n: 2, _parent: g1._rev });
  const fetched = getRevision(store, g1._rev);
  ok(fetched);
  deepStrictEqual(fetched._rev, g1._rev);
  deepStrictEqual(parseRev(fetched._rev).gen, 1);
});

test("bulkInsert - creates forks (two leaves with the same parent)", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const g2a = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    n: 2,
    from: "A",
  });
  const g2b = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    n: 2,
    from: "B",
  });

  const result = bulkInsert(store, [g1, g2a, g2b]);
  deepStrictEqual(result.inserted, 3);
  deepStrictEqual(result.skipped, 0);
  deepStrictEqual(result.rejected, []);

  const leaves = getLeaves(store, "k");
  deepStrictEqual(leaves.length, 2);
  ok(
    leaves.some((l) => l._rev === g2a._rev) &&
      leaves.some((l) => l._rev === g2b._rev),
  );
});

test("winner selection - prefers non-deleted over deleted", () => {
  const store = freshStore();
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

  const resolved = getResolved(store, "k");
  ok(resolved);
  deepStrictEqual(resolved.winner._rev, live._rev);
  deepStrictEqual(resolved.conflicts, []);
  deepStrictEqual(resolved.deletedConflicts, [tomb._rev]);
});

test("winner selection - higher gen wins among non-deleted leaves", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const g2 = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, n: 2 });
  const g3 = buildDoc({ _id: "k", _gen: 3, _parent: g2._rev, n: 3 });
  const g2Fork = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    v: "fork",
  });
  bulkInsert(store, [g1, g2, g3, g2Fork]);

  const resolved = getResolved(store, "k");
  ok(resolved);
  deepStrictEqual(resolved.winner._rev, g3._rev);
  deepStrictEqual(resolved.conflicts, [g2Fork._rev]);
  deepStrictEqual(resolved.deletedConflicts, []);
});

test("winner selection - gen is ordered numerically, not lexicographically (gen 11 beats gen 2)", () => {
  const store = freshStore();
  // Build a chain up to gen 11 on one branch and a sibling at gen 2 on the other.
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const chain: BulkDocument[] = [g1];
  let parent = g1;
  for (let gen = 2; gen <= 11; gen++) {
    const next = buildDoc({
      _id: "k",
      _gen: gen,
      _parent: parent._rev,
      n: gen,
    });
    chain.push(next);
    parent = next;
  }
  const sibling = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    fork: true,
  });
  bulkInsert(store, [...chain, sibling]);

  const resolved = getResolved(store, "k");
  ok(resolved);
  deepStrictEqual(resolved.winner._rev, parent._rev);
  ok(resolved.winner._rev.startsWith("11-"));
});

test("winner selection - tiebreak on lexicographic hash among same-gen siblings", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const a = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    v: "aaa",
  });
  const b = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    v: "bbb",
  });
  bulkInsert(store, [g1, a, b]);
  const resolved = getResolved(store, "k");
  ok(resolved);
  const aHash = parseRev(a._rev).hash;
  const bHash = parseRev(b._rev).hash;
  const expectedWinner = aHash < bHash ? a._rev : b._rev;
  const expectedLoser = aHash < bHash ? b._rev : a._rev;
  deepStrictEqual(resolved.winner._rev, expectedWinner);
  deepStrictEqual(resolved.conflicts, [expectedLoser]);
  deepStrictEqual(resolved.deletedConflicts, []);
});

test("getResolved - splits live vs deleted leaves into conflicts vs deletedConflicts", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const liveA = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    v: "live-a",
  });
  const liveB = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    v: "live-b",
  });
  const tombA = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    _deleted: true,
    via: "A",
  });
  const tombB = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    _deleted: true,
    via: "B",
  });
  bulkInsert(store, [g1, liveA, liveB, tombA, tombB]);

  const resolved = getResolved(store, "k");
  ok(resolved);
  // Winner is one of the live leaves
  ok([liveA._rev, liveB._rev].includes(resolved.winner._rev));
  // Other live leaf is in conflicts
  const expectedLiveConflict =
    resolved.winner._rev === liveA._rev ? liveB._rev : liveA._rev;
  deepStrictEqual(resolved.conflicts, [expectedLiveConflict]);
  // Both tombstones are in deletedConflicts (sorted by hash within deleted group)
  deepStrictEqual(
    [...resolved.deletedConflicts].sort(),
    [tombA._rev, tombB._rev].sort(),
  );
});

test("getResolved - all-deleted document: winner is a tombstone, conflicts empty", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const tombA = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    _deleted: true,
    via: "A",
  });
  const tombB = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    _deleted: true,
    via: "B",
  });
  bulkInsert(store, [g1, tombA, tombB]);

  const resolved = getResolved(store, "k");
  ok(resolved);
  deepStrictEqual(resolved.winner._deleted, true);
  ok([tombA._rev, tombB._rev].includes(resolved.winner._rev));
  deepStrictEqual(resolved.conflicts, []);
  // The other tombstone is in deletedConflicts
  const expectedDeletedLoser =
    resolved.winner._rev === tombA._rev ? tombB._rev : tombA._rev;
  deepStrictEqual(resolved.deletedConflicts, [expectedDeletedLoser]);
});

test("bulkInsert - rejects a doc whose _rev does not match its content", () => {
  const store = freshStore();
  const good = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const tampered: BulkDocument = {
    ...good,
    n: 999,
  };
  const result = bulkInsert(store, [good, tampered]);
  deepStrictEqual(result.inserted, 1);
  deepStrictEqual(result.rejected.length, 1);
  deepStrictEqual(result.rejected[0].rev, tampered._rev);
});

test("bulkInsert - accepts docs with missing ancestors (no enforcement)", () => {
  const store = freshStore();
  const orphan = buildDoc({
    _id: "k",
    _gen: 5,
    _parent: "4-ghostparentrevghostparentrevghostparentrevghostpar",
    orphan: true,
  });
  const result = bulkInsert(store, [orphan]);
  deepStrictEqual(result.inserted, 1);
  deepStrictEqual(result.rejected, []);

  const leaves = getLeaves(store, "k");
  deepStrictEqual(leaves.length, 1);
  deepStrictEqual(leaves[0]._rev, orphan._rev);
});

test("bulkInsert - duplicate _rev is a skip, not an error", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const first = bulkInsert(store, [g1]);
  const second = bulkInsert(store, [g1]);
  deepStrictEqual(first.inserted, 1);
  deepStrictEqual(second.inserted, 0);
  deepStrictEqual(second.skipped, 1);
});

test("changesSince - returns all revisions in _local_seq order", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "a", n: 1 });
  const g2 = put(store, { _id: "a", n: 2, _parent: g1._rev });
  const b1 = put(store, { _id: "b", n: 10 });

  const all = changesSince(store, 0);
  deepStrictEqual(
    all.map((r) => r._rev),
    [g1._rev, g2._rev, b1._rev],
  );

  const sinceG2 = changesSince(store, g2._local_seq);
  deepStrictEqual(
    sinceG2.map((r) => r._rev),
    [b1._rev],
  );
});

test("round-trip - doc from get can be replayed via bulkInsert on a fresh store", () => {
  const a = freshStore();
  const original = put(a, { _id: "x", name: "Alice", age: 30 });

  const b = freshStore();
  const result = bulkInsert(b, [original as unknown as BulkDocument]);
  deepStrictEqual(result.inserted, 1);

  const onB = get(b, "x");
  ok(onB);
  deepStrictEqual(onB._rev, original._rev);
  deepStrictEqual(onB.name, "Alice");
  deepStrictEqual(onB.age, 30);
});

test("replica convergence - identical write sequences produce identical _revs", () => {
  const a = freshStore();
  const b = freshStore();
  const a1 = put(a, { _id: "k", x: 1 });
  const a2 = put(a, { _id: "k", x: 2, _parent: a1._rev });
  const b1 = put(b, { _id: "k", x: 1 });
  const b2 = put(b, { _id: "k", x: 2, _parent: b1._rev });
  deepStrictEqual(a1._rev, b1._rev);
  deepStrictEqual(a2._rev, b2._rev);
});

test("getRevisionBulk - empty input returns empty receipt without touching DB", () => {
  const store = freshStore();
  const r = getRevisionBulk(store, []);
  deepStrictEqual(r.documents, []);
  deepStrictEqual(r.missing, []);
});

test("getRevisionBulk - returns docs in input order regardless of insertion order", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const g2 = put(store, { _id: "k", n: 2, _parent: g1._rev });
  const g3 = put(store, { _id: "k", n: 3, _parent: g2._rev });

  const r = getRevisionBulk(store, [g3._rev, g1._rev, g2._rev]);
  deepStrictEqual(
    r.documents.map((d) => d._rev),
    [g3._rev, g1._rev, g2._rev],
  );
  deepStrictEqual(r.missing, []);
});

test("getRevisionBulk - missing revs surface in missing, not documents", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const fake = formatRev(1, "deadbeef");

  const r = getRevisionBulk(store, [g1._rev, fake]);
  deepStrictEqual(r.documents.length, 1);
  deepStrictEqual(r.documents[0]._rev, g1._rev);
  deepStrictEqual(r.missing, [fake]);
});

test("getRevisionBulk - duplicate existing revs duplicate in documents", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });

  const r = getRevisionBulk(store, [g1._rev, g1._rev, g1._rev]);
  deepStrictEqual(r.documents.length, 3);
  deepStrictEqual(
    r.documents.map((d) => d._rev),
    [g1._rev, g1._rev, g1._rev],
  );
  deepStrictEqual(r.missing, []);
});

test("getRevisionBulk - duplicate missing revs deduped in missing", () => {
  const store = freshStore();
  const fake = formatRev(1, "deadbeef");
  const r = getRevisionBulk(store, [fake, fake, fake]);
  deepStrictEqual(r.documents, []);
  deepStrictEqual(r.missing, [fake]);
});

test("getRevisionBulk - all-missing input returns empty docs and deduped missing", () => {
  const store = freshStore();
  const a = formatRev(1, "aaaa");
  const b = formatRev(1, "bbbb");
  const r = getRevisionBulk(store, [a, b, a]);
  deepStrictEqual(r.documents, []);
  deepStrictEqual(r.missing, [a, b]);
});

test("getHistory - linear chain returns leaf-to-root order", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const g2 = put(store, { _id: "k", n: 2, _parent: g1._rev });
  const g3 = put(store, { _id: "k", n: 3, _parent: g2._rev });

  const history = getHistory(store, "k");
  deepStrictEqual(
    history.map((d) => d._rev),
    [g3._rev, g2._rev, g1._rev],
  );
});

test("getHistory - default rev equals starting from the winner", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const g2 = put(store, { _id: "k", n: 2, _parent: g1._rev });

  const winner = get(store, "k");
  ok(winner);
  const a = getHistory(store, "k");
  const b = getHistory(store, "k", winner._rev);
  deepStrictEqual(
    a.map((d) => d._rev),
    b.map((d) => d._rev),
  );
  deepStrictEqual(a[0]._rev, g2._rev);
});

test("getHistory - divergent leaves: each leaf walks back to shared root", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const g2a = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    from: "A",
  });
  const g2b = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    from: "B",
  });
  bulkInsert(store, [g1, g2a, g2b]);

  const histA = getHistory(store, "k", g2a._rev);
  const histB = getHistory(store, "k", g2b._rev);
  deepStrictEqual(
    histA.map((d) => d._rev),
    [g2a._rev, g1._rev],
  );
  deepStrictEqual(
    histB.map((d) => d._rev),
    [g2b._rev, g1._rev],
  );
});

test("getHistory - unknown id returns empty array", () => {
  const store = freshStore();
  deepStrictEqual(getHistory(store, "nope"), []);
});

test("getHistory - unknown rev returns empty array", () => {
  const store = freshStore();
  put(store, { _id: "k", n: 1 });
  deepStrictEqual(getHistory(store, "k", formatRev(1, "deadbeef")), []);
});

test("getHistory - rev belongs to a different document is rejected", () => {
  const store = freshStore();
  put(store, { _id: "k", n: 1 });
  const other = put(store, { _id: "j", n: 1 });
  // asking for "k"'s history starting from a "j" rev should not return "j"
  deepStrictEqual(getHistory(store, "k", other._rev), []);
});
