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
  get,
  getLeaves,
  getResolved,
  getRevision,
  openStore,
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

/** Construct a BulkDocument with a correctly computed `_hash`. */
const buildDoc = (
  fields: Omit<BulkDocument, "_hash"> & { _deleted?: boolean },
): BulkDocument => {
  const data = extractData(fields as Record<string, unknown>);
  const _deleted = fields._deleted ?? false;
  const _hash = revisionHash({
    _id: fields._id,
    _gen: fields._gen,
    _parent: fields._parent,
    _type: fields._type,
    _deleted,
    data,
  });
  return { ...fields, _deleted, _hash };
};

test("openStore - creates schema and close works", () => {
  const store = freshStore();
  const doc = put(store, { _id: "a", n: 1 });
  assertEquals(doc._gen, 1);
  closeStore(store);
});

test("put - genesis write: _gen 1, no parent, _hash matches, _seq 1, data inlined", () => {
  const store = freshStore();
  const doc = put(store, { _id: "doc", hello: "world" });
  assertEquals(doc._id, "doc");
  assertEquals(doc._gen, 1);
  assertEquals(doc._parent, undefined);
  assertEquals(doc._deleted, false);
  assertEquals(doc._type, undefined);
  assertEquals(doc._seq, 1);
  assertEquals(doc.hello, "world");
  assertEquals(
    doc._hash,
    revisionHash({
      _id: "doc",
      _gen: 1,
      _parent: undefined,
      _type: undefined,
      _deleted: false,
      data: { hello: "world" },
    }),
  );
});

test("put - linear extension bumps _gen; previous rev is no longer a leaf", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const g2 = put(store, { _id: "k", n: 2, _parent: g1._hash });

  assertEquals(g2._gen, 2);
  assertEquals(g2._parent, g1._hash);

  const leaves = getLeaves(store, "k");
  assertEquals(leaves.length, 1);
  assertEquals(leaves[0]._hash, g2._hash);
});

test("put - missing _parent when a leaf exists throws ConflictError", () => {
  const store = freshStore();
  put(store, { _id: "k", n: 1 });
  assertThrows(() => put(store, { _id: "k", n: 2 }), ConflictError);
});

test("put - stale _parent (pointing to former leaf) throws ConflictError", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  put(store, { _id: "k", n: 2, _parent: g1._hash });
  assertThrows(
    () => put(store, { _id: "k", n: 3, _parent: g1._hash }),
    ConflictError,
  );
});

test("put - genesis put with a _parent that does not exist throws ConflictError", () => {
  const store = freshStore();
  assertThrows(
    () => put(store, { _id: "k", n: 1, _parent: "nonexistenthash" }),
    ConflictError,
  );
});

test("put - is idempotent when called twice with identical content+parent", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const a = put(store, { _id: "k", n: 2, _parent: g1._hash });
  const b = put(store, { _id: "k", n: 2, _parent: g1._hash });
  assertEquals(a._hash, b._hash);
  assertEquals(a._seq, b._seq);
  const all = changesSince(store, 0);
  assertEquals(all.length, 2);
});

test("put - non-reserved `_`-prefixed fields pass through into user data", () => {
  const store = freshStore();
  const doc = put(store, { _id: "x", _custom: "keep", regular: 1 });
  assertEquals(doc._custom, "keep");
  assertEquals(doc.regular, 1);
  // And they participate in the hash (changing _custom changes _hash).
  const other = put(store, { _id: "y", _custom: "diff", regular: 1 });
  assert(doc._hash !== other._hash);
});

test("remove - produces a tombstone that stays in the leaf set", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  const tomb = remove(store, "k", g1._hash);
  assertEquals(tomb._deleted, true);
  assertEquals(tomb._gen, 2);
  assertEquals(tomb._parent, g1._hash);

  const leaves = getLeaves(store, "k");
  assertEquals(leaves.length, 1);
  assertEquals(leaves[0]._hash, tomb._hash);
});

test("get - returns the tombstone when every leaf is deleted", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  remove(store, "k", g1._hash);
  const winner = get(store, "k");
  assertExists(winner);
  assertEquals(winner._deleted, true);
});

test("get - returns undefined for an unknown _id", () => {
  const store = freshStore();
  assertEquals(get(store, "nope"), undefined);
});

test("getRevision - returns a specific rev by _hash regardless of leaf status", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", n: 1 });
  put(store, { _id: "k", n: 2, _parent: g1._hash });
  const fetched = getRevision(store, g1._hash);
  assertExists(fetched);
  assertEquals(fetched._hash, g1._hash);
  assertEquals(fetched._gen, 1);
});

test("bulkInsert - creates forks (two leaves with the same parent)", () => {
  const store = freshStore();
  const g1 = buildDoc({
    _id: "k",
    _gen: 1,
    _createdAt: 1,
    n: 1,
  });
  const g2a = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _createdAt: 2,
    n: 2,
    from: "A",
  });
  const g2b = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _createdAt: 3,
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
    leaves.some((l) => l._hash === g2a._hash) &&
      leaves.some((l) => l._hash === g2b._hash),
  );
});

test("winner selection - prefers non-deleted over deleted", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, _createdAt: 1, n: 1 });
  const live = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _createdAt: 2,
    v: "live",
  });
  const tomb = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _deleted: true,
    _createdAt: 3,
  });
  bulkInsert(store, [g1, live, tomb]);

  const resolved = getResolved(store, "k");
  assertExists(resolved);
  assertEquals(resolved.winner._hash, live._hash);
  assertEquals(resolved.conflicts, [tomb._hash]);
});

test("winner selection - higher _gen wins among non-deleted leaves", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, _createdAt: 1, n: 1 });
  const g2 = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _createdAt: 2,
    n: 2,
  });
  const g3 = buildDoc({
    _id: "k",
    _gen: 3,
    _parent: g2._hash,
    _createdAt: 3,
    n: 3,
  });
  const g2Fork = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _createdAt: 4,
    v: "fork",
  });
  bulkInsert(store, [g1, g2, g3, g2Fork]);

  const resolved = getResolved(store, "k");
  assertExists(resolved);
  assertEquals(resolved.winner._hash, g3._hash);
  assertEquals(resolved.conflicts, [g2Fork._hash]);
});

test("winner selection - tiebreak on lexicographic _hash among same-gen siblings", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, _createdAt: 1, n: 1 });
  const a = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _createdAt: 2,
    v: "aaa",
  });
  const b = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._hash,
    _createdAt: 3,
    v: "bbb",
  });
  bulkInsert(store, [g1, a, b]);
  const resolved = getResolved(store, "k");
  assertExists(resolved);
  const expectedWinner = a._hash < b._hash ? a._hash : b._hash;
  const expectedLoser = a._hash < b._hash ? b._hash : a._hash;
  assertEquals(resolved.winner._hash, expectedWinner);
  assertEquals(resolved.conflicts, [expectedLoser]);
});

test("bulkInsert - rejects a doc whose _hash does not match", () => {
  const store = freshStore();
  const good = buildDoc({ _id: "k", _gen: 1, _createdAt: 1, n: 1 });
  const tampered: BulkDocument = {
    ...good,
    _hash: "fakehashfakehashfakehashfakehashfakehashfakehashfake",
    n: 999,
  };
  const result = bulkInsert(store, [good, tampered]);
  assertEquals(result.inserted, 1);
  assertEquals(result.rejected.length, 1);
  assertEquals(result.rejected[0].hash, tampered._hash);
});

test("bulkInsert - accepts docs with missing ancestors (no enforcement)", () => {
  const store = freshStore();
  const orphan = buildDoc({
    _id: "k",
    _gen: 5,
    _parent: "ghostparenthashghostparenthashghostparenthashghost00",
    _createdAt: 1,
    orphan: true,
  });
  const result = bulkInsert(store, [orphan]);
  assertEquals(result.inserted, 1);
  assertEquals(result.rejected, []);

  const leaves = getLeaves(store, "k");
  assertEquals(leaves.length, 1);
  assertEquals(leaves[0]._hash, orphan._hash);
});

test("bulkInsert - duplicate _hash is a skip, not an error", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, _createdAt: 1, n: 1 });
  const first = bulkInsert(store, [g1]);
  const second = bulkInsert(store, [g1]);
  assertEquals(first.inserted, 1);
  assertEquals(second.inserted, 0);
  assertEquals(second.skipped, 1);
});

test("changesSince - returns all revisions in _seq order", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "a", n: 1 });
  const g2 = put(store, { _id: "a", n: 2, _parent: g1._hash });
  const b1 = put(store, { _id: "b", n: 10 });

  const all = changesSince(store, 0);
  assertEquals(
    all.map((r) => r._hash),
    [g1._hash, g2._hash, b1._hash],
  );

  const sinceG2 = changesSince(store, g2._seq);
  assertEquals(
    sinceG2.map((r) => r._hash),
    [b1._hash],
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
  assertEquals(ok._gen, 1);
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
    _parent: s1._hash,
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
  assertEquals(doc._gen, 1);
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
  assertEquals(good._gen, 1);

  assertEquals(getRevision(sourceB, schemaDoc._hash)?._hash, schemaDoc._hash);
});

test("round-trip - doc from get can be replayed via bulkInsert on a fresh store", () => {
  const a = freshStore();
  const original = put(a, { _id: "x", name: "Alice", age: 30 });

  const b = freshStore();
  const result = bulkInsert(b, [original as unknown as BulkDocument]);
  assertEquals(result.inserted, 1);

  const onB = get(b, "x");
  assertExists(onB);
  assertEquals(onB._hash, original._hash);
  assertEquals(onB.name, "Alice");
  assertEquals(onB.age, 30);
});
