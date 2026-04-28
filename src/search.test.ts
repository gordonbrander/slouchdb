import { test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  bulkInsert,
  closeStore,
  extractData,
  formatRev,
  openStore,
  parseRev,
  put,
  remove,
  replicate,
  revisionHash,
  type BulkDocument,
  type Store,
} from "./store.ts";
import { search } from "./search.ts";
import { openDatabase } from "./sqlite.ts";

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

test("search - basic match returns the doc whose content contains the term", () => {
  const store = freshStore();
  put(store, { _id: "a", body: "alpha quick brown" });
  put(store, { _id: "b", body: "beta lazy fox" });

  const hits = search(store, { query: "alpha" });
  deepStrictEqual(hits.length, 1);
  deepStrictEqual(hits[0].document._id, "a");
});

test("search - porter stemming finds 'running' when querying 'run'", () => {
  const store = freshStore();
  put(store, { _id: "k", body: "the runners are running fast" });

  const hits = search(store, { query: "run" });
  deepStrictEqual(hits.length, 1);
  deepStrictEqual(hits[0].document._id, "k");
});

test("search - walks nested JSON to index string leaves", () => {
  const store = freshStore();
  put(store, { _id: "k", a: { b: { c: "needle" } } });

  const hits = search(store, { query: "needle" });
  deepStrictEqual(hits.length, 1);
  deepStrictEqual(hits[0].document._id, "k");
});

test("search - numeric leaves are not indexed", () => {
  const store = freshStore();
  put(store, { _id: "k", count: 12345, label: "marker" });

  deepStrictEqual(search(store, { query: "12345" }).length, 0);
  deepStrictEqual(search(store, { query: "marker" }).length, 1);
});

test("search - new revision replaces old content (no longer matches former winner's terms)", () => {
  const store = freshStore();
  const v1 = put(store, { _id: "k", body: "alpha" });
  put(store, { _id: "k", _parent: v1._rev, body: "beta" });

  deepStrictEqual(search(store, { query: "alpha" }).length, 0);
  const beta = search(store, { query: "beta" });
  deepStrictEqual(beta.length, 1);
  deepStrictEqual(beta[0].document._id, "k");
  deepStrictEqual(beta[0].document.body, "beta");
});

test("search - tombstone removes the doc from the index", () => {
  const store = freshStore();
  const v1 = put(store, { _id: "k", body: "alpha" });
  remove(store, "k", v1._rev);

  deepStrictEqual(search(store, { query: "alpha" }).length, 0);
});

test("search - resurrection (live child of tombstone) re-adds the doc", () => {
  const store = freshStore();
  const v1 = put(store, { _id: "k", body: "alpha" });
  const tomb = remove(store, "k", v1._rev);
  put(store, { _id: "k", _parent: tomb._rev, body: "gamma" });

  deepStrictEqual(search(store, { query: "alpha" }).length, 0);
  const gamma = search(store, { query: "gamma" });
  deepStrictEqual(gamma.length, 1);
  deepStrictEqual(gamma[0].document._id, "k");
});

test("search - conflict: only the winner is searchable; loser's terms do not match", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, body: "shared" });
  const aLeaf = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    body: "apple",
  });
  const bLeaf = buildDoc({
    _id: "k",
    _gen: 2,
    _parent: g1._rev,
    body: "banana",
  });
  bulkInsert(store, [g1, aLeaf, bLeaf]);

  // Winner among same-gen siblings is the one with lower lexicographic hash.
  const aHash = parseRev(aLeaf._rev).hash;
  const bHash = parseRev(bLeaf._rev).hash;
  const expectedWinner = aHash < bHash ? aLeaf : bLeaf;
  const winnerTerm = expectedWinner === aLeaf ? "apple" : "banana";
  const loserTerm = expectedWinner === aLeaf ? "banana" : "apple";

  const winnerHits = search(store, { query: winnerTerm });
  deepStrictEqual(winnerHits.length, 1);
  deepStrictEqual(winnerHits[0].document._rev, expectedWinner._rev);

  deepStrictEqual(search(store, { query: loserTerm }).length, 0);
});

test("search - higher-gen leaf inserted later flips the index to the new winner", () => {
  const store = freshStore();
  const g1 = put(store, { _id: "k", body: "alpha" });
  const g2 = put(store, { _id: "k", _parent: g1._rev, body: "beta" });
  const g3 = buildDoc({ _id: "k", _gen: 3, _parent: g2._rev, body: "gamma" });
  bulkInsert(store, [g3]);

  deepStrictEqual(search(store, { query: "alpha" }).length, 0);
  deepStrictEqual(search(store, { query: "beta" }).length, 0);
  const gamma = search(store, { query: "gamma" });
  deepStrictEqual(gamma.length, 1);
  deepStrictEqual(gamma[0].document._rev, g3._rev);
});

test("search - replication ingress (out-of-order ancestors) leaves the index reflecting the leaf", () => {
  const store = freshStore();
  const g1 = buildDoc({ _id: "k", _gen: 1, body: "alpha" });
  const g2 = buildDoc({ _id: "k", _gen: 2, _parent: g1._rev, body: "beta" });
  const g3 = buildDoc({ _id: "k", _gen: 3, _parent: g2._rev, body: "gamma" });

  // Insert leaf-first, ancestors after.
  bulkInsert(store, [g3]);
  deepStrictEqual(search(store, { query: "gamma" }).length, 1);

  bulkInsert(store, [g2]);
  deepStrictEqual(search(store, { query: "gamma" }).length, 1);
  deepStrictEqual(search(store, { query: "beta" }).length, 0);

  bulkInsert(store, [g1]);
  deepStrictEqual(search(store, { query: "gamma" }).length, 1);
  deepStrictEqual(search(store, { query: "alpha" }).length, 0);
});

test("search - replicate() populates the index on the destination", () => {
  const a = freshStore();
  const b = freshStore();
  put(a, { _id: "x", body: "alpha" });
  put(a, { _id: "y", body: "beta" });

  replicate(a, b, 0);

  deepStrictEqual(search(b, { query: "alpha" }).length, 1);
  deepStrictEqual(search(b, { query: "beta" }).length, 1);
});

test("search - empty/whitespace query short-circuits to []", () => {
  const store = freshStore();
  put(store, { _id: "k", body: "alpha" });

  deepStrictEqual(search(store, { query: "" }), []);
  deepStrictEqual(search(store, { query: "   " }), []);
});

test("search - limit is clamped to [1, 1000]", () => {
  const store = freshStore();
  for (let i = 0; i < 5; i++) {
    put(store, { _id: `k${i}`, body: "alpha" });
  }

  deepStrictEqual(search(store, { query: "alpha", limit: 0 }).length, 1);
  deepStrictEqual(search(store, { query: "alpha", limit: 3 }).length, 3);
  deepStrictEqual(search(store, { query: "alpha", limit: 99999 }).length, 5);
});

test("search - default limit is 25", () => {
  const store = freshStore();
  for (let i = 0; i < 30; i++) {
    put(store, { _id: `k${i}`, body: "alpha" });
  }
  deepStrictEqual(search(store, { query: "alpha" }).length, 25);
});

test("search - prefix and phrase syntax pass through to FTS5", () => {
  const store = freshStore();
  put(store, { _id: "a", body: "alphabet soup" });
  put(store, { _id: "b", body: "different words" });

  const prefix = search(store, { query: "alpha*" });
  deepStrictEqual(prefix.length, 1);
  deepStrictEqual(prefix[0].document._id, "a");

  const phrase = search(store, { query: '"alphabet soup"' });
  deepStrictEqual(phrase.length, 1);
  deepStrictEqual(phrase[0].document._id, "a");
});

test("search - SearchHit carries a numeric bm25 score", () => {
  const store = freshStore();
  put(store, { _id: "k", body: "alpha" });
  const [hit] = search(store, { query: "alpha" });
  ok(hit);
  ok(typeof hit.score === "number");
});

test("search - migration v2 backfills existing rows when upgrading from v1", () => {
  // Fixture: the v1 schema as it existed before FTS5 was added. Migrations
  // are append-only, so this string is a permanent snapshot of v1.
  const v1Sql = `
    CREATE TABLE documents (
      _local_seq  INTEGER PRIMARY KEY AUTOINCREMENT,
      _rev        TEXT UNIQUE NOT NULL,
      _id         TEXT NOT NULL,
      _parent     TEXT,
      _type       TEXT,
      _deleted    INTEGER NOT NULL DEFAULT 0,
      data        TEXT NOT NULL,
      _rev_gen    INTEGER GENERATED ALWAYS AS
                    (CAST(substr(_rev, 1, instr(_rev, '-') - 1) AS INTEGER)) STORED,
      _rev_hash   TEXT GENERATED ALWAYS AS
                    (substr(_rev, instr(_rev, '-') + 1)) STORED
    );
    CREATE INDEX documents_id_idx ON documents(_id);
    CREATE INDEX documents_parent_idx ON documents(_parent);
  `;

  const path = join(tmpdir(), `slouchdb-fts-${randomUUID()}.db`);
  try {
    // Phase 1: v1 only — populate without any FTS triggers.
    const v1Store = openDatabase(path, [v1Sql]) as Store;
    const a = put(v1Store, { _id: "a", body: "alpha" });
    const b = put(v1Store, { _id: "b", body: "beta" });
    remove(v1Store, "a", a._rev);
    void b;

    // A conflict on a third id, with two siblings of the same generation.
    const g1 = buildDoc({ _id: "c", _gen: 1, body: "shared" });
    const c2x = buildDoc({
      _id: "c",
      _gen: 2,
      _parent: g1._rev,
      body: "winnerterm",
    });
    const c2y = buildDoc({
      _id: "c",
      _gen: 2,
      _parent: g1._rev,
      body: "loserterm",
    });
    bulkInsert(v1Store, [g1, c2x, c2y]);
    closeStore(v1Store);

    // Phase 2: reopen with full migrations — v2 runs and backfills.
    const upgraded = openStore(path);

    // Live doc is findable.
    deepStrictEqual(search(upgraded, { query: "beta" }).length, 1);
    // Tombstoned doc is not.
    deepStrictEqual(search(upgraded, { query: "alpha" }).length, 0);
    // Conflict: only the lexicographically lower hash wins.
    const xHash = parseRev(c2x._rev).hash;
    const yHash = parseRev(c2y._rev).hash;
    const winnerTerm = xHash < yHash ? "winnerterm" : "loserterm";
    const loserTerm = xHash < yHash ? "loserterm" : "winnerterm";
    deepStrictEqual(search(upgraded, { query: winnerTerm }).length, 1);
    deepStrictEqual(search(upgraded, { query: loserTerm }).length, 0);

    closeStore(upgraded);
  } finally {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
});
