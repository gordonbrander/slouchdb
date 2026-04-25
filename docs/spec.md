# slouchdb core: CouchDB-like document store over `node:sqlite`

## Context

slouchdb today has content-addressed hashing (`src/cid.ts`) and a
JSONSchema resolver (`src/schema-resolver.ts`), plus a working storage
layer. The goal is the project's core: a local document
store with CouchDB semantics — revision trees, optimistic concurrency,
deterministic conflict-winner selection, per-type JSONSchema validation, and a
changes feed that supports replication from/to another slouchdb instance.

Scope per user direction:

- **Include replication** — bulk-insert API that creates forks, changes feed
  with sequence numbers.
- **Schemas are documents** — no separate `schemas` table; schemas live in the
  `documents` table under a reserved type and key convention, so they
  participate in MVCC and replicate like any other document.
- **Sync API** — `node:sqlite` is synchronous; match it, no Promise wrapper.
- **Reserved field names mirror CouchDB** where concepts align: `_id`, `_rev`,
  `_deleted`, with `_parent` naming the parent revision explicitly.

## Data model

### Single `documents` table

```sql
CREATE TABLE documents (
  _local_seq  INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic local write order
  _rev        TEXT UNIQUE NOT NULL,               -- "<gen>-<hash>"
  _id         TEXT NOT NULL,                      -- document id
  _parent     TEXT,                               -- NULL for genesis, else parent _rev
  _type       TEXT,                               -- NULL or a type name
  _deleted    INTEGER NOT NULL DEFAULT 0,         -- 0 | 1 (tombstone flag)
  data        TEXT NOT NULL,                      -- JSON body (user data only)
  _rev_gen    INTEGER GENERATED ALWAYS AS
                (CAST(substr(_rev, 1, instr(_rev, '-') - 1) AS INTEGER)) STORED,
  _rev_hash   TEXT    GENERATED ALWAYS AS
                (substr(_rev, instr(_rev, '-') + 1)) STORED
);
CREATE INDEX documents_id_idx ON documents(_id);
CREATE INDEX documents_parent_idx ON documents(_parent);
```

- `_rev` is the PRIMARY identity of a revision; `UNIQUE` makes duplicate
  writes of the same revision (e.g. during replication) a natural no-op via
  `INSERT OR IGNORE`.
- `_local_seq` (SQLite rowid via `AUTOINCREMENT`) drives the changes feed. It
  is local to this replica; it is not part of revision identity.
- `_rev_gen` and `_rev_hash` are stored generated columns so winner-selection
  SQL can sort the generation numerically (lexicographic ordering would place
  `"11-…"` before `"2-…"`).
- One row = one revision. Ancestry is reconstructed via `_parent`.

### Revision identity

A `_rev` is the string `"<gen>-<hash>"`:

- `gen` is `1` for genesis and `parent.gen + 1` for an extension.
- `hash = cid({ _id, _gen, _parent, _type, _deleted, ...data })`, where
  `_parent` in the hash input is the full parent `_rev` string (or `null` for
  genesis) and `data` is the user-data portion of the document (reserved
  fields removed).

Including `_gen` and `_parent` in the hash input means identical edits from
two replicas converge to the same `_rev`, while identical content at
different generations hashes differently. `cid` already gives deterministic,
key-sorted lowercase-hex SHA-256 output. `_local_seq` is intentionally
excluded — it varies by replica.

### Winner selection (CouchDB rules)

Among the leaves of an `_id` (revisions with no child), the winner is:

```sql
SELECT * FROM <leaves>
ORDER BY _deleted ASC, _rev_gen DESC, _rev_hash ASC
LIMIT 1;
```

Identical on every replica, so no coordination is needed.

### Schemas as documents

Schemas live in the same table. Conventions:

- A schema doc has `_type = "_schema"`.
- Its `_id` is `_schema/<type-name>` (mirrors CouchDB's `_design/<name>`).
- Its user data is a JSONSchema object.
- Schema documents themselves are **not** schema-validated — there is no
  registered schema for `_schema` and introducing a meta-schema is out of
  scope for v1.
- To validate a write with `_type = "foo"`: look up the winning revision of
  `_id = "_schema/foo"`; if it exists and is not a tombstone, compile with
  `z.fromJSONSchema` and validate the user-data portion.

Because schema docs are versioned under the same MVCC, schema evolution is
just another write; replication ships schemas alongside data.

## API surface (all synchronous)

### `src/store.ts`

Documents are read and written as flattened objects — reserved fields sit
alongside user data at the top level.

```ts
import { DatabaseSync } from "node:sqlite";

export type Store = { db: DatabaseSync; validate: Validator };

export type Document = {
  _local_seq: number;
  _rev: string;                 // "<gen>-<hash>"
  _id: string;
  _parent: string | undefined;  // parent's full _rev, or undefined for genesis
  _type: string | undefined;
  _deleted: boolean;
  [field: string]: unknown;     // user data fields
};

export type PutInput = {
  _id: string;
  _type?: string;
  _parent?: string;             // required if a leaf already exists
  _deleted?: boolean;           // default false
  [field: string]: unknown;     // user data fields
};

export type BulkDocument = {
  _id: string;
  _rev: string;                 // pre-computed
  _parent?: string;
  _type?: string;
  _deleted?: boolean;
  [field: string]: unknown;
};

export const openStore = (
  path: string,
  opts?: { validate?: Validator },
): Store;
export const closeStore = (store: Store): void;

// Compose / parse the "<gen>-<hash>" _rev format.
export const formatRev = (gen: number, hash: string): string;
export const parseRev = (rev: string): { gen: number; hash: string };

// Optimistic-concurrency write. Extends one leaf. Returns the new document.
// Throws ConflictError if _parent is not a current leaf.
// Throws ValidationError if _type is set and data fails schema check.
export const put = (store: Store, input: PutInput): Document;

// Convenience: creates a tombstone extending parentRev.
export const remove = (store: Store, id: string, parentRev: string): Document;

// Returns the winning revision (winner algorithm). Undefined if no row exists.
// Tombstones ARE returned — caller checks `_deleted`.
export const get = (store: Store, id: string): Document | undefined;

// Returns a specific revision by _rev, regardless of leaf status.
export const getRevision = (store: Store, rev: string): Document | undefined;

// All current leaves for an id. Used to detect conflicts.
export const getLeaves = (store: Store, id: string): Document[];

// Winner + _revs of losing leaves (CouchDB's ?conflicts=true shape).
export type Resolved = { winner: Document; conflicts: string[] };
export const getResolved = (store: Store, id: string): Resolved | undefined;

// Replication-style bulk insert. Bypasses the leaf check; creates forks.
// Each revision's _rev is reparsed and its hash recomputed against the
// supplied fields; tampered rows are rejected. Schema validation is NOT
// run here — replication must not stall because the local replica hasn't
// received the schema yet.
export type BulkResult = {
  inserted: number;
  skipped: number;
  rejected: Array<{ rev: string; reason: string }>;
};
export const bulkInsert = (
  store: Store,
  docs: readonly BulkDocument[],
): BulkResult;

// Changes feed. All revisions with _local_seq > since, in order.
// This is "style: all_docs" semantics — every leaf shows up.
export const changesSince = (store: Store, since: number): Document[];
```

### `src/validate.ts`

Separated so `store.ts` doesn't import zod:

```ts
import * as z from "zod/v4";
import { type Store, type PendingDocument } from "./store.ts";

// Compiles and caches zod schemas keyed by the schema document's _rev.
// Content-addressed cache: when the schema doc changes, its _rev changes,
// and a new compiled schema is built on the next call.
export const validate = (
  store: Store,
  type: string,
  doc: PendingDocument,
): void;
```

`store.put` calls `validate(store, _type, pending)` before insert when `_type`
is set and is not `"_schema"`. A failure throws `ValidationError` and the
transaction is rolled back.

### `src/errors.ts`

```ts
export class ConflictError extends Error {
  /* has .id, .expectedParent, .actualLeaves */
}
export class ValidationError extends Error {
  /* has .issues */
}
export class IntegrityError extends Error {
  /* bulkInsert hash mismatch */
}
```

## Behavior details

### `put`

Wrap in a `BEGIN IMMEDIATE` transaction:

1. Look up current leaves of `_id`.
2. Derive generation:
   - **Genesis** (`_parent` undefined): `_gen = 1`.
   - **Extension**: `_gen = parseRev(_parent).gen + 1`.
3. Compute `hash = cid({ _id, _gen, _parent, _type, _deleted, ...data })`
   and compose `_rev = formatRev(_gen, hash)`.
4. Idempotence: if a row with this `_rev` already exists, commit and return it.
5. If `_type` is set and `_type !== "_schema"`: run `validate` (throws on failure).
6. Leaf check:
   - Genesis: `leaves.length === 0` or throw `ConflictError`.
   - Extension: `_parent` must equal one current leaf's `_rev` or throw.
7. `INSERT OR IGNORE` the row, then re-fetch by `_rev` to pick up `_local_seq`.
8. Return the full `Document`.

### `bulkInsert`

Replication ingress. For each input revision:

1. `parseRev(doc._rev)` — malformed `_rev` → push to `rejected`, continue.
2. Recompute `cid({...})` from the supplied fields and compare to the parsed
   hash. Mismatch → push to `rejected`, continue.
3. If `_parent` is non-null and the parent row does not exist locally →
   insert anyway (CouchDB allows missing ancestors; they may arrive later).
   Note: we do **not** attempt stemming / ancestor pruning in v1.
4. `INSERT OR IGNORE`. Count `changes()` toward `inserted`, else `skipped`.
5. Schema validation is skipped entirely in this path.

Wrap the whole batch in a single transaction.

### `changesSince`

```sql
SELECT * FROM documents WHERE _local_seq > ? ORDER BY _local_seq;
```

No filtering, no collapsing. Callers pick their own checkpoint. Every
revision is emitted, which is CouchDB's `style=all_docs`.

### Reserved identifiers

- `_type = "_schema"` — self-describing schema document (not validated).
- `_id = "_schema/<name>"` — schema for documents with `_type = <name>`.
- Other `_`-prefixed `_id`s/`_type`s are reserved for future use (e.g. design
  docs, local-only docs); v1 does not add them.
- Reserved document fields: `_id`, `_rev`, `_parent`, `_type`, `_deleted`,
  `_local_seq`. Non-reserved `_`-prefixed fields pass through as user data.

## File layout

- `src/sqlite.ts` — `openDatabase(path, migrations)`, migration runner.
  Migrations are plain SQL strings in an array; runner tracks applied
  versions in a `_migrations` table.
- `src/store.ts` — types + all document APIs listed above.
- `src/store.test.ts` — unit tests.
- `src/validate.ts` — schema-cache + `validate(store, type, doc)`.
- `src/validate.test.ts` — unit tests.
- `src/errors.ts` — error classes.
- `src/test-helpers.ts` — thin wrappers over `node:assert`:
  `assertEquals`, `assertNotEquals`, `assertStrictEquals`, `assert`,
  `assertRejects`, `assertThrows`, `assertExists`.

Reuse:

- `src/cid.ts` — `cid()` for revision hashes; do **not** reimplement.

## Test plan

Use `node --test src/*.test.ts`. Co-locate, match existing style.

### `store.test.ts`

- **Open/close**: fresh DB creates expected schema; re-opening existing DB
  is idempotent.
- **`parseRev` / `formatRev`**: round-trip; reject malformed input (missing
  dash, non-integer gen, zero gen).
- **Genesis put**: `_rev` begins with `"1-"`, `_parent = undefined`, `_rev`
  matches `formatRev(1, cid(...))`, `_local_seq` is 1.
- **Linear extension**: second put with correct `_parent` succeeds, new `_rev`
  has gen 2, previous is no longer a leaf.
- **Write conflict**: put with stale/missing `_parent` throws `ConflictError`.
- **Idempotent put**: writing the same content+parent twice yields the same
  `_rev` and inserts only one row.
- **Tombstone via `remove`**: adds a revision with `_deleted = true`, stays
  in the leaf set, loses winner selection to any non-deleted sibling.
- **Bulk insert creates forks**: insert two sibling revisions with the same
  `_parent` via `bulkInsert`; both persist; `getLeaves` returns both;
  `get` returns the winner by the rules.
- **Winner selection rules**:
  - prefers non-deleted over deleted
  - among same deleted status, higher generation wins
  - generation is compared numerically (gen `11` beats gen `2`)
  - tiebreak on lexicographic hash
- **Bulk insert integrity**: reject a revision whose recomputed hash does
  not match; other revisions in the batch still succeed.
- **Bulk insert with missing parent**: accepted (we don't validate ancestry
  locally); leaf set is still correct.
- **Changes feed**: `changesSince(0)` returns all revisions in `_local_seq`
  order; `changesSince(lastSeq)` returns only new ones.
- **Replica convergence**: identical write sequences on two fresh stores
  produce identical `_rev`s.
- **Schema validation on put**: register `_schema/note` with a JSONSchema
  requiring `title: string`; a put without `title` throws `ValidationError`;
  a put with `title` succeeds.
- **Schema evolution**: update `_schema/note` to a stricter version;
  subsequent puts validate against the new schema.
- **Schema docs are not self-validated**: writing an arbitrary JSONSchema at
  `_schema/x` with `_type = "_schema"` succeeds without a meta-schema.
- **Replication of schemas**: `bulkInsert` a schema revision; a subsequent
  `put` of that type validates against the replicated schema.

### `validate.test.ts`

- Cache hit: two calls with the same schema-doc `_rev` reuse the compiled zod.
- Cache invalidation on schema update: put a new schema revision → the old
  compiled zod is not reused.
- Unknown type → no schema doc → treated as "no validation" (store writes it).
  Rationale: avoids blocking replication where schemas arrive later;
  enforcement happens when the schema exists.

## Verification

End-to-end sanity check:

1. `npm run check` — type-check clean.
2. `npm test` — all suites pass.

## Out of scope for v1 (flagged for later)

- Revision-tree pruning / stemming (CouchDB keeps the last N generations
  per branch; we keep everything).
- `open_revs=all` read API (can be derived from `getLeaves`).
- HTTP surface — we're building a library, not a server yet.
- Compaction / tombstone purging.
- Attachments.
- View / MapReduce indexes.
- A meta-schema for `_schema` documents.
