import { test } from "node:test";
import {
  assert,
  assertEquals,
  assertExists,
  assertThrows,
} from "./test-helpers.ts";
import {
  bulkInsert,
  changesSince,
  closeStore,
  extractData,
  formatRev,
  get,
  getLeaves,
  getResolved,
  getRevision,
  openStore,
  parseRev,
  put,
  remove,
  revisionHash,
  type BulkDocument,
  type Store,
} from "./store.ts";
import { ConflictError, ValidationError } from "./errors.ts";
import { clearSchemaCache, validate } from "./validate.ts";

const freshStore = (): Store => openStore(":memory:");

const freshValidatingStore = (): Store => {
  clearSchemaCache();
  return openStore(":memory:", { validate });
};

/** Construct a BulkDocument with a correctly computed `_rev`. */
const buildDoc = (
  fields: Omit<BulkDocument, "_rev"> & { _gen: number; _deleted?: boolean },
): BulkDocument => {
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
  assertEquals(rev, "7-abcdef");
  const parsed = parseRev(rev);
  assertEquals(parsed.gen, 7);
  assertEquals(parsed.hash, "abcdef");

  assertThrows(() => parseRev("no-dash-start"), Error);
  assertThrows(() => parseRev("-leadingdash"), Error);
  assertThrows(() => parseRev("notanumber-hash"), Error);
  assertThrows(() => parseRev("0-zerogen"), Error);
  assertThrows(() => parseRev("1.5-frac"), Error);
});

test("openStore - creates schema and close works", () => {
  const store = freshStore();
  const doc = put(store, { _id: "a", n: 1 });
  assertEquals(parseRev(doc._rev).gen, 1);
  closeStore(store);
});

test("put - genesis write: gen 1 in _rev, no parent, _rev matches, _local_seq 1, data inlined", () => {
  const store = freshStore();
  const doc = put(store, { _id: "doc", hello: "world" });
  assertEquals(doc._id, "doc");
  assertEquals(parseRev(doc._rev).gen, 1);
  assert(doc._rev.startsWith("1-"));
  assertEquals(doc._parent, undefined);
  assertEquals(doc._deleted, false);
  assertEquals(doc._type, undefined);
  assertEquals(doc._local_seq, 1);
  assertEquals(doc.hello, "world");
  const expectedHash = revisionHash({
    _id: "doc",
    _gen: 1,
    _parent: undefined,
    _type: undefined,
    _deleted: false,
    data: { hello: "world" },
  });
  assertEquals(doc._rev, formatRev(1, expectedHash));
});

test("put - linear extension bumps gen; previous rev is no longer a leaf", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const g2 = put(store, { _id: "k", n: 2, _parent: g1._rev });

  assertEquals(parseRev(g2._rev).gen, 2);
  assertEquals(g2._parent, g1._rev);

  const leaves = getLeaves(store, "k");
  assertEquals(leaves.length, 1);
  assertEquals(leaves[0]._rev, g2._rev);
});

test("put - missing _parent when a leaf exists throws ConflictError", () => {
  const store = freshStore();
  put(store, { _id: "k", n: 1 });
  assertThrows(() => put(store, { _id: "k", n: 2 }), ConflictError);
});

test("put - stale _parent (pointing to former leaf) throws ConflictError", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  put(store, { _id: "k", n: 2, _parent: g1._rev });
  assertThrows(
    () => put(store, { _id: "k", n: 3, _parent: g1._rev }),
    ConflictError,
  );
});

test("put - genesis put with a _parent that does not exist throws ConflictError", () => {
  const store = freshStore();
  assertThrows(
    () => put(store, { _id: "k", n: 1, _parent: "1-nonexistentrev" }),
    ConflictError,
  );
});

test("put - is idempotent when called twice with identical content+parent", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const a = put(store, { _id: "k", n: 2, _parent: g1._rev });
  const b = put(store, { _id: "k", n: 2, _parent: g1._rev });
  assertEquals(a._rev, b._rev);
  assertEquals(a._local_seq, b._local_seq);
  const all = changesSince(store, 0);
  assertEquals(all.length, 2);
});

test("put - non-reserved `_`-prefixed fields pass through into user data", () => {
  const store = freshStore();
  const doc = put(store, { _id: "x", _custom: "keep", regular: 1 });
  assertEquals(doc._custom, "keep");
  assertEquals(doc.regular, 1);
  const other = put(store, { _id: "y", _custom: "diff", regular: 1 });
  assert(doc._rev !== other._rev);
});

test("remove - produces a tombstone that stays in the leaf set", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const tomb = remove(store, "k", g1._rev);
  assertEquals(tomb._deleted, true);
  assertEquals(parseRev(tomb._rev).gen, 2);
  assertEquals(tomb._parent, g1._rev);

  const leaves = getLeaves(store, "k");
  assertEquals(leaves.length, 1);
  assertEquals(leaves[0]._rev, tomb._rev);
});

test("get - returns the tombstone when every leaf is deleted", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  remove(store, "k", g1._rev);
  const winner = get(store, "k");
  assertExists(winner);
  assertEquals(winner._deleted, true);
});

test("get - returns undefined for an unknown _id", () => {
  const store = freshStore();
  assertEquals(get(store, "nope"), undefined);
});

test("getRevision - returns a specific rev by _rev regardless of leaf status", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  put(store, { _id: "k", n: 2, _parent: g1._rev });
  const fetched = getRevision(store, g1._rev);
  assertExists(fetched);
  assertEquals(fetched._rev, g1._rev);
  assertEquals(parseRev(fetched._rev).gen, 1);
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
  assertEquals(result.inserted, 3);
  assertEquals(result.skipped, 0);
  assertEquals(result.rejected, []);

  const leaves = getLeaves(store, "k");
  assertEquals(leaves.length, 2);
  assert(
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
  assertExists(resolved);
  assertEquals(resolved.winner._rev, live._rev);
  assertEquals(resolved.conflicts, [tomb._rev]);
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
  assertExists(resolved);
  assertEquals(resolved.winner._rev, g3._rev);
  assertEquals(resolved.conflicts, [g2Fork._rev]);
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
  assertExists(resolved);
  assertEquals(resolved.winner._rev, parent._rev);
  assert(resolved.winner._rev.startsWith("11-"));
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
  assertExists(resolved);
  const aHash = parseRev(a._rev).hash;
  const bHash = parseRev(b._rev).hash;
  const expectedWinner = aHash < bHash ? a._rev : b._rev;
  const expectedLoser = aHash < bHash ? b._rev : a._rev;
  assertEquals(resolved.winner._rev, expectedWinner);
  assertEquals(resolved.conflicts, [expectedLoser]);
});

test("bulkInsert - rejects a doc whose _rev does not match its content", () => {
  const store = freshStore();
  const good = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const tampered: BulkDocument = {
    ...good,
    n: 999,
  };
  const result = bulkInsert(store, [good, tampered]);
  assertEquals(result.inserted, 1);
  assertEquals(result.rejected.length, 1);
  assertEquals(result.rejected[0].rev, tampered._rev);
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
  assertEquals(result.inserted, 1);
  assertEquals(result.rejected, []);

  const leaves = getLeaves(store, "k");
  assertEquals(leaves.length, 1);
  assertEquals(leaves[0]._rev, orphan._rev);
});

test("bulkInsert - duplicate _rev is a skip, not an error", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, n: 1 });
  const first = bulkInsert(store, [g1]);
  const second = bulkInsert(store, [g1]);
  assertEquals(first.inserted, 1);
  assertEquals(second.inserted, 0);
  assertEquals(second.skipped, 1);
});

test("changesSince - returns all revisions in _local_seq order", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "a", n: 1 });
  const g2 = put(store, { _id: "a", n: 2, _parent: g1._rev });
  const b1 = put(store, { _id: "b", n: 10 });

  const all = changesSince(store, 0);
  assertEquals(
    all.map((r) => r._rev),
    [g1._rev, g2._rev, b1._rev],
  );

  const sinceG2 = changesSince(store, g2._local_seq);
  assertEquals(
    sinceG2.map((r) => r._rev),
    [b1._rev],
  );
});

test("validation - rejects writes that violate the registered schema", () => {
  const store = freshValidatingStore();
  put(store, {
    _id: "_schema/note",
    _type: "_schema",
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  });
  assertThrows(
    () => put(store, { _id: "n1", _type: "note" }),
    ValidationError,
  );
  const ok = put(store, { _id: "n1", _type: "note", title: "hi" });
  assertEquals(parseRev(ok._rev).gen, 1);
  assertEquals(ok.title, "hi");
});

test("validation - schema evolution: updating the schema changes validation", () => {
  const store = freshValidatingStore();
  const s1 = put(store, {
    _id: "_schema/item",
    _type: "_schema",
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  put(store, { _id: "i1", _type: "item", name: "x" });

  put(store, {
    _id: "_schema/item",
    _type: "_schema",
    _parent: s1._rev,
    type: "object",
    properties: { name: { type: "string" }, qty: { type: "number" } },
    required: ["name", "qty"],
  });

  assertThrows(
    () => put(store, { _id: "i2", _type: "item", name: "y" }),
    ValidationError,
  );
  put(store, { _id: "i2", _type: "item", name: "y", qty: 3 });
});

test("validation - _schema documents are never self-validated", () => {
  const store = freshValidatingStore();
  put(store, {
    _id: "_schema/anything",
    _type: "_schema",
    any: "json",
    at: ["all"],
  });
});

test("validation - _type with no registered schema is a no-op (permits writes)", () => {
  const store = freshValidatingStore();
  const doc = put(store, { _id: "m1", _type: "mystery", x: 1 });
  assertEquals(parseRev(doc._rev).gen, 1);
});

test("replication - schemas propagate, and subsequent puts validate", () => {
  const sourceA = freshValidatingStore();
  const schemaDoc = put(sourceA, {
    _id: "_schema/post",
    _type: "_schema",
    type: "object",
    properties: { body: { type: "string" } },
    required: ["body"],
  });

  const sourceB = freshValidatingStore();
  const changes = changesSince(sourceA, 0);
  const result = bulkInsert(sourceB, changes as unknown as BulkDocument[]);
  assertEquals(result.inserted, 1);

  assertThrows(
    () => put(sourceB, { _id: "p1", _type: "post" }),
    ValidationError,
  );
  const good = put(sourceB, { _id: "p1", _type: "post", body: "hello" });
  assertEquals(parseRev(good._rev).gen, 1);

  assertEquals(getRevision(sourceB, schemaDoc._rev)?._rev, schemaDoc._rev);
});

test("round-trip - doc from get can be replayed via bulkInsert on a fresh store", () => {
  const a = freshStore();
  const original = put(a, { _id: "x", name: "Alice", age: 30 });

  const b = freshStore();
  const result = bulkInsert(b, [original as unknown as BulkDocument]);
  assertEquals(result.inserted, 1);

  const onB = get(b, "x");
  assertExists(onB);
  assertEquals(onB._rev, original._rev);
  assertEquals(onB.name, "Alice");
  assertEquals(onB.age, 30);
});

test("replica convergence - identical write sequences produce identical _revs", () => {
  const a = freshStore();
  const b = freshStore();
  const a1 = put(a, { _id: "k", x: 1 });
  const a2 = put(a, { _id: "k", x: 2, _parent: a1._rev });
  const b1 = put(b, { _id: "k", x: 1 });
  const b2 = put(b, { _id: "k", x: 2, _parent: b1._rev });
  assertEquals(a1._rev, b1._rev);
  assertEquals(a2._rev, b2._rev);
});
