# slouchdb core: CouchDB-like document store over `node:sqlite`

## Context

slouchdb today has content-addressed hashing (`src/lib/cid.ts`), base32
(`src/lib/base32.ts`), and a JSONSchema resolver (`src/lib/schema-resolver.ts`),
but no storage layer. The goal is the project's core: a local document store
with CouchDB semantics — revision trees, optimistic concurrency, deterministic
conflict-winner selection, per-type JSONSchema validation, and a changes feed
that supports replication from/to another slouchdb instance.

Scope per user direction:
- **Include replication** — bulk-insert API that creates forks, changes feed
  with sequence numbers.
- **Schemas are documents** — no separate `schemas` table; schemas live in the
  `documents` table under a reserved type and key convention, so they
  participate in MVCC and replicate like any other document.
- **Sync API** — `node:sqlite` is synchronous; match it, no Promise wrapper.

## Data model

### Single `documents` table

```sql
CREATE TABLE documents (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic write order
  hash        TEXT UNIQUE NOT NULL,               -- cid() of the revision
  key         TEXT NOT NULL,                      -- document id
  generation  INTEGER NOT NULL,                   -- 1 for genesis, parent.gen+1 otherwise
  parent_hash TEXT,                               -- NULL for genesis, else a hash
  type        TEXT,                               -- NULL or a type name
  data        TEXT NOT NULL,                      -- JSON body
  deleted     INTEGER NOT NULL DEFAULT 0,         -- 0 | 1 (tombstone flag)
  created_at  INTEGER NOT NULL                    -- Unix ms; debug-only, not a tiebreaker
);
CREATE INDEX documents_key_idx ON documents(key);
CREATE INDEX documents_parent_idx ON documents(parent_hash);
```

- `hash` is the PRIMARY identity of a revision; `UNIQUE` makes duplicate writes
  of the same revision (e.g. during replication) a natural no-op via
  `INSERT OR IGNORE`.
- `seq` (SQLite rowid via `AUTOINCREMENT`) drives the changes feed.
- One row = one revision. Ancestry is reconstructed via `parent_hash`.

### Revision hash

```
hash = cid({ key, generation, parent_hash, type, data, deleted })
```

Including `generation` and `parent_hash` means identical edits from two
replicas converge to the same hash, while identical content at different
generations hashes differently. `cid` already gives deterministic,
key-sorted SHA-256 base32 output.

### Winner selection (CouchDB rules)

Among the leaves of a key (revisions with no child), the winner is:

```sql
SELECT * FROM <leaves>
ORDER BY deleted ASC, generation DESC, hash ASC
LIMIT 1;
```

Identical on every replica, so no coordination is needed.

### Schemas as documents

Schemas live in the same table. Conventions:

- A schema doc has `type = "_schema"`.
- Its `key` is `_schema/<type-name>` (mirrors CouchDB's `_design/<name>`).
- Its `data` is a JSONSchema object.
- Schema documents themselves are **not** schema-validated — there is no
  registered schema for `_schema` and introducing a meta-schema is out of
  scope for v1.
- To validate a write with `type = "foo"`: look up the winning revision of
  key `_schema/foo`; if it exists and is not a tombstone, compile with
  `z.fromJSONSchema` and validate `data`.

Because schema docs are versioned under the same MVCC, schema evolution is
just another write; replication ships schemas alongside data.

## API surface (all synchronous)

### `src/lib/store.ts`

```ts
import { DatabaseSync } from "node:sqlite";

export type Store = { db: DatabaseSync };

export type Revision = {
  hash: string;
  key: string;
  generation: number;
  parentHash: string | undefined;
  type: string | undefined;
  data: unknown;          // parsed JSON
  deleted: boolean;
  seq: number;
  createdAt: number;
};

export type PutInput = {
  key: string;
  data: unknown;
  type?: string;
  parentHash?: string;    // required if a leaf already exists
  deleted?: boolean;      // default false
};

export const openStore = (path: string): Store;
export const closeStore = (store: Store): void;

// Optimistic-concurrency write. Extends one leaf. Returns the new revision.
// Throws ConflictError if parentHash is not a current leaf.
// Throws ValidationError if type is set and data fails schema check.
export const put = (store: Store, input: PutInput): Revision;

// Convenience: creates a tombstone extending parentHash.
export const remove = (store: Store, key: string, parentHash: string): Revision;

// Returns the winning revision (winner algorithm). Undefined if no row exists.
// Tombstones ARE returned — caller checks `deleted`.
export const get = (store: Store, key: string): Revision | undefined;

// Returns a specific revision by hash, regardless of leaf status.
export const getRevision = (store: Store, hash: string): Revision | undefined;

// All current leaves for a key. Used to detect conflicts.
export const getLeaves = (store: Store, key: string): Revision[];

// Winner + hashes of losing leaves (CouchDB's ?conflicts=true shape).
export type Resolved = { winner: Revision; conflicts: string[] };
export const getResolved = (store: Store, key: string): Resolved | undefined;

// Replication-style bulk insert. Bypasses the leaf check; creates forks.
// Each revision's hash is re-verified against cid(); tampered rows are rejected.
// Schema validation is best-effort (logged, not enforced) — replication must
// not stall because the local replica hasn't received the schema yet.
// Returns { inserted, skipped, rejected }.
export type BulkResult = { inserted: number; skipped: number; rejected: string[] };
export const bulkInsert = (store: Store, revisions: Revision[]): BulkResult;

// Changes feed. All revisions with seq > since, in seq order.
// This is "style: all_docs" semantics — every leaf shows up.
export const changesSince = (store: Store, since: number): Revision[];
```

### `src/lib/validate.ts`

Separated so `store.ts` doesn't import zod:

```ts
import * as z from "zod/v4";
import { type Store, type Revision } from "./store.ts";

// Compiles and caches zod schemas keyed by the schema document's hash.
// Content-addressed cache: when the schema doc changes, its hash changes,
// and a new compiled schema is built on the next call.
export const validate = (store: Store, type: string, data: unknown): void;
```

`store.put` calls `validate(store, type, data)` before insert when `type` is
set and is not `"_schema"`. A failure throws `ValidationError` and the
transaction is rolled back.

### `src/lib/errors.ts`

```ts
export class ConflictError extends Error { /* has .key, .expectedParent */ }
export class ValidationError extends Error { /* has .issues */ }
export class IntegrityError extends Error { /* bulkInsert hash mismatch */ }
```

## Behavior details

### `put`

Wrap in a `BEGIN IMMEDIATE` transaction:

1. If `type` set and `type !== "_schema"`: run `validate` (throws on failure).
2. Look up current leaves of `key`.
   - **Genesis** (no rows for key): `parentHash` must be undefined;
     `generation = 1`.
   - **Extension**: `parentHash` must equal exactly one current leaf's hash;
     `generation = parent.generation + 1`.
   - Otherwise: throw `ConflictError`.
3. Compute `hash = cid({ key, generation, parent_hash, type, data, deleted })`.
4. `INSERT OR IGNORE` (duplicate hash → no-op, still return the existing row).
5. Return the full `Revision`.

### `bulkInsert`

Replication ingress. For each input revision:

1. Recompute `cid({…})` and compare to provided `hash`. Mismatch → push to
   `rejected`, continue.
2. If `parent_hash` is non-null and the parent row does not exist locally →
   insert anyway (CouchDB allows missing ancestors; they may arrive later).
   Note: we do **not** attempt stemming / ancestor pruning in v1.
3. `INSERT OR IGNORE`. Count `changes()` toward `inserted`, else `skipped`.
4. Optional: log schema-validation failures for traceability; do not block.

Wrap the whole batch in a single transaction.

### `changesSince`

```sql
SELECT * FROM documents WHERE seq > ? ORDER BY seq;
```

No filtering, no collapsing. Callers pick their own checkpoint. Every
revision is emitted, which is CouchDB's `style=all_docs`.

### Reserved identifiers

- `type = "_schema"` — self-describing schema document (not validated).
- `key = "_schema/<name>"` — schema for documents with `type = <name>`.
- Other `_`-prefixed keys/types are reserved for future use (e.g. design
  docs, local-only docs); v1 does not add them.

## File layout

New files:

- `src/lib/sqlite.ts` — `openDatabase(path)`, migration runner. Migrations
  are plain SQL strings in an array; runner tracks applied version in a
  `_migrations` table.
- `src/lib/store.ts` — types + all document APIs listed above.
- `src/lib/store.test.ts` — unit tests (details below).
- `src/lib/validate.ts` — schema-cache + `validate(store, type, data)`.
- `src/lib/validate.test.ts` — unit tests.
- `src/lib/errors.ts` — error classes.
- `src/lib/test-helpers.ts` — if not present. Existing tests import it
  (`cid.test.ts:2`, `base32.test.ts`, `schema-resolver.test.ts`) so either
  it already exists outside the explored paths, or it's an outstanding
  prerequisite. If missing, add thin wrappers over `node:assert`:
  `assertEquals`, `assertNotEquals`, `assertStrictEquals`, `assert`,
  `assertRejects`, `assertThrows`, `assertExists`.

Reuse:
- `src/lib/cid.ts` — `cid()` for revision hashes; do **not** reimplement.
- `src/lib/schema-resolver.ts` — the pattern is reused, but a schema
  *resolver* that reads files from disk is not used here; schemas live in
  the store. The caching pattern (`cachedResolverOf`) is worth mirroring
  in `validate.ts` as a hash → `ZodType` map.

## Test plan

Use `node --test src/lib/*.test.ts`. Co-locate, match existing style.

### `store.test.ts`

- **Open/close**: fresh DB creates expected schema; re-opening existing DB
  is idempotent.
- **Genesis put**: `generation = 1`, `parent_hash = null`, `hash` matches
  `cid(...)`, `seq` is 1.
- **Linear extension**: second put with correct `parentHash` succeeds,
  `generation = 2`, previous is no longer a leaf.
- **Write conflict**: put with stale/missing `parentHash` throws
  `ConflictError` (single-DB optimistic concurrency).
- **Idempotent put**: writing the same content+parent twice yields the same
  `hash` and inserts only one row.
- **Tombstone via `remove`**: adds revision with `deleted = 1`, stays in the
  leaf set, loses winner selection to any non-deleted sibling.
- **Bulk insert creates forks**: insert two sibling revisions with the same
  `parent_hash` via `bulkInsert`; both persist; `getLeaves` returns both;
  `get` returns the winner by the rules.
- **Winner selection rules**:
  - prefers non-deleted over deleted
  - among same deleted status, higher `generation` wins
  - tiebreak on lexicographic `hash`
- **Bulk insert integrity**: reject a revision whose `hash` does not match
  `cid({...})`; other revisions in the batch still succeed.
- **Bulk insert with missing parent**: accepted (we don't validate ancestry
  locally); leaf set is still correct.
- **Changes feed**: `changesSince(0)` returns all revisions in `seq` order;
  with `since = lastSeq` after further writes, returns only new ones.
- **Schema validation on put**: register `_schema/note` with a JSONSchema
  requiring `title: string`; `put({ key: "n1", type: "note", data: {} })`
  throws `ValidationError`; `put({ ..., data: { title: "hi" } })` succeeds.
- **Schema evolution**: update `_schema/note` to a stricter version;
  subsequent puts validate against the new schema; older data is untouched
  (not revalidated).
- **Schema docs are not self-validated**: `put({ key: "_schema/x", type:
  "_schema", data: { /* any JSONSchema */ } })` succeeds without a meta-
  schema registered.
- **Replication of schemas**: `bulkInsert` a schema revision; a subsequent
  `put` of that type validates against the replicated schema.

### `validate.test.ts`

- Cache hit: two calls with the same schema-doc hash compile zod once
  (observable via a mock compiler, or by swapping to `cachedResolverOf`-
  style plumbing).
- Cache invalidation on schema update: put a new schema revision → the old
  compiled zod is not reused.
- Unknown type → no schema doc → treated as "no validation" (store writes
  it). Rationale: avoids blocking replication where schemas arrive later;
  enforcement happens when the schema exists.

## Verification

End-to-end sanity check before calling the feature done:

1. `npm test` (once `package.json` gets a `test` script pointed at
   `node --test src/**/*.test.ts`). All new suites pass.
2. `node --check` the new files (`node --check src/lib/store.ts`, etc.) to
   confirm native type stripping accepts them.
3. Manual smoke script at `scripts/slouchdb-demo.ts`:
   - open a temp DB,
   - register a schema,
   - put a valid doc, then an invalid doc (expect `ValidationError`),
   - simulate replication: open a second DB, `changesSince(0)` on the first,
     `bulkInsert` into the second,
   - assert `get` on both DBs returns identical winners.
   The script is illustrative, not committed as a test — delete it after.

## Out of scope for v1 (flagged for later)

- Revision-tree pruning / stemming (CouchDB keeps the last N generations
  per branch; we keep everything).
- `open_revs=all` read API (can be derived from `getLeaves`).
- HTTP surface — we're building a library, not a server yet.
- Compaction / tombstone purging.
- Attachments.
- View / MapReduce indexes.
- A meta-schema for `_schema` documents.
