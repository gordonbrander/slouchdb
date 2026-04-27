# slouchdb core: CouchDB-like document store over `node:sqlite`

## Context

slouchdb is a local document store with CouchDB semantics — revision trees,
optimistic concurrency, deterministic conflict-winner selection, and a
changes feed that supports replication from/to another slouchdb instance.
The store is schema-agnostic; enforcement is left to the caller.

Scope:

- **Include replication** — bulk-insert API that creates forks, changes feed
  with sequence numbers.
- **Schemas are documents** — no separate `schemas` table; schemas live in the
  `documents` table under a reserved type and key convention, so they
  participate in MVCC and replicate like any other document.
- **Schema enforcement is out of scope** — the store does not validate.
  Replication must never stall on a typed document whose schema hasn't
  replicated yet, and consumers may want to enforce, warn, or skip on their
  own terms. Pick any validator.
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
  meta-schema for `_schema` and introducing one is out of scope for v1.
- To validate a write with `_type = "foo"`: callers `get(store,
"_schema/foo")`, check that it exists and is not a tombstone, then run
  whatever validator they prefer (e.g. compile the JSONSchema via
  `z.fromJSONSchema` or `ajv`) against the document's user-data portion
  before `put`. The store itself never calls a validator.

Because schema docs are versioned under the same MVCC, schema evolution is
just another write; replication ships schemas alongside data.

## API surface (all synchronous)

### `src/store.ts`

Documents are read and written as flattened objects — reserved fields sit
alongside user data at the top level.

```ts
import { type DatabaseSync } from "node:sqlite";

export type Store = DatabaseSync;

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

export const RESERVED: ReadonlySet<string>;

export const openStore = (path: string): Store;
export const closeStore = (store: Store): void;

// Compose / parse the "<gen>-<hash>" _rev format.
export const formatRev = (gen: number, hash: string): string;
export const parseRev = (rev: string): { gen: number; hash: string };

// Strip reserved fields from a doc-shaped record. Reused by callers that
// build BulkDocuments by hand (see `revisionHash`).
export const extractData = (
  doc: Record<string, unknown>,
): Record<string, unknown>;

// Compute the bare hash for a revision. Callers compose the full _rev via
// `formatRev`. Useful for tests and tools that synthesize BulkDocuments.
export const revisionHash = (input: {
  _id: string;
  _gen: number;
  _parent: string | undefined;
  _type: string | undefined;
  _deleted: boolean;
  data: Record<string, unknown>;
}): string;

// Optimistic-concurrency write. Extends one leaf. Returns the new document.
// Throws ConflictError if _parent is not a current leaf. The store itself
// performs no schema validation — callers validate however they like before
// calling `put`.
export const put = (store: Store, input: PutInput): Document;

// Convenience: creates a tombstone extending parentRev.
export const remove = (store: Store, id: string, parentRev: string): Document;

// Returns the winning revision (winner algorithm). Undefined if no row exists.
// Tombstones ARE returned — caller checks `_deleted`.
export const get = (store: Store, id: string): Document | undefined;

// Returns a specific revision by _rev, regardless of leaf status.
export const getRevision = (store: Store, rev: string): Document | undefined;

// Bulk fetch. Returns matched documents in input order plus any unknown
// revs. Duplicate input revs duplicate in `documents`; `missing` is deduped.
export type GetRevisionBulkReceipt = {
  documents: Document[];
  missing: string[];
};
export const getRevisionBulk = (
  store: Store,
  revs: readonly string[],
): GetRevisionBulkReceipt;

// All current leaves for an id. Used to detect conflicts.
export const getLeaves = (store: Store, id: string): Document[];

// Winner + losing leaves split by deletion status. Mirrors CouchDB's
// ?conflicts=true (`_conflicts`) and ?deleted_conflicts=true
// (`_deleted_conflicts`) read shapes. The doc is "in conflict" exactly when
// `conflicts.length > 0`.
export type DocWithConflicts = {
  winner: Document;
  conflicts: string[];          // live (non-tombstone) losing leaves
  deletedConflicts: string[];   // tombstone leaves
};
export const getWithConflicts = (store: Store, id: string): DocWithConflicts | undefined;

// Walk the parent chain leaf-to-root. Default start is the winner of `id`.
// Stops at the first missing ancestor. Empty if `id` is unknown, the
// supplied `rev` is unknown, or `rev` belongs to a different document.
export const getHistory = (
  store: Store,
  id: string,
  rev?: string,
): Document[];

// Replication-style bulk insert. Bypasses the leaf check; creates forks.
// Each revision's _rev is reparsed and its hash recomputed against the
// supplied fields; tampered rows are rejected (tracked, not thrown).
// Missing ancestors are permitted.
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
// This is "style: all_docs" semantics — every revision shows up.
export const changesSince = (store: Store, since: number): Document[];
```

### `src/resolve.ts`

Conflict-resolution helper. Lives outside the store so the store stays small
and the merge policy is pluggable.

```ts
import { type Document, type PutInput, type Store } from "./store.ts";

// Receives all live leaves in canonical order [winner, ...losers] and
// returns the merged content. The caller (`resolve`) overrides _id and
// _parent on the result.
export type Reconciler = (leaves: readonly Document[]) => PutInput;

// Atomically: write the merged document under the winner's branch, then
// tombstone every live losing leaf. No-op (returns the existing winner)
// when there are no live conflicts. Undefined if `id` is absent.
//
// Determinism: leaves are passed in `_deleted ASC, _rev_gen DESC,
// _rev_hash ASC` order, anchored on the winner's _rev. Two replicas
// running the same reconciler over the same leaves produce the same
// merge _rev.
export const resolve = (
  store: Store,
  id: string,
  reconcile: Reconciler,
): Document | undefined;
```

### `src/errors.ts`

```ts
export class ConflictError extends Error {
  /* has .id, .expectedParent, .actualLeaves */
}
export class IntegrityError extends Error {
  /* bulkInsert hash mismatch — has .providedHash, .computedHash */
}
```

There is no `ValidationError`: the store does not validate.

## Behavior details

### `put`

Wrapped in a `savepoint`:

1. Look up current leaves of `_id`.
2. Derive generation:
   - **Genesis** (`_parent` undefined): `_gen = 1`.
   - **Extension**: `_gen = parseRev(_parent).gen + 1`.
3. Compute `hash = cid({ _id, _gen, _parent, _type, _deleted, ...data })`
   and compose `_rev = formatRev(_gen, hash)`.
4. Idempotence: if a row with this `_rev` already exists, commit and return it.
5. Leaf check:
   - Genesis: `leaves.length === 0` or throw `ConflictError`.
   - Extension: `_parent` must equal one current leaf's `_rev` or throw.
6. `INSERT OR IGNORE` the row, then re-fetch by `_rev` to pick up `_local_seq`.
7. Return the full `Document`.

`put` performs no schema validation. Callers that want validation should
run their preferred validator on the input before calling `put`.

### `bulkInsert`

Replication ingress. For each input revision:

1. `parseRev(doc._rev)` — malformed `_rev` → push to `rejected`, continue.
2. Recompute `cid({...})` from the supplied fields and compare to the parsed
   hash. Mismatch → push to `rejected`, continue.
3. If `_parent` is non-null and the parent row does not exist locally →
   insert anyway (CouchDB allows missing ancestors; they may arrive later).
   Note: we do **not** attempt stemming / ancestor pruning in v1.
4. `INSERT OR IGNORE`. Count `changes()` toward `inserted`, else `skipped`.

The store performs no schema validation in any path; `bulkInsert` is no
exception. Wrap the whole batch in a single transaction (savepoint).

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

- `src/sqlite.ts` — `openDatabase(path, migrations)` and `savepoint(...)`.
  Migrations are plain SQL strings in an array; runner tracks applied
  versions in a `_migrations` table.
- `src/store.ts` — types + all document APIs listed above.
- `src/store.test.ts` — unit tests.
- `src/resolve.ts` — `resolve(store, id, reconcile)` conflict-merge helper.
- `src/resolve.test.ts` — unit tests.
- `src/errors.ts` — error classes.
- `src/index.ts` — re-exports `./store` and `./errors`. The `resolve`
  module is reached via the `slouchdb/resolve` subpath export so consumers
  that don't need it can ignore it.

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
- **Schema docs participate in MVCC**: writing an arbitrary JSONSchema at
  `_schema/x` with `_type = "_schema"` succeeds; the store does not treat
  schema documents specially at write time.

### `resolve.test.ts`

- Missing doc → `undefined`.
- No live conflict → returns the existing winner; reconciler not called;
  leaf set unchanged.
- Two-leaf conflict: merged revision is a child of the previous winner;
  losing leaf is tombstoned; new winner is the merge.
- Reconciler sees `[winner, ...losers]` in canonical order.
- Three-leaf conflict: one live leaf afterwards, two tombstones.
- Determinism: same reconciler on two replicas produces the same merge `_rev`.
- Reconciler throw rolls back: leaf set unchanged.
- Reconciler returning a different `_id` is overridden (caller can't escape
  the targeted document).
- Doc with only `deletedConflicts` (no live competitors) is a no-op.

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
