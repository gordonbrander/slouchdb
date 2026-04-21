# slouchdb

CouchDB, but for SQLite. A local, embeddable document store with CouchDB
semantics — revision trees, optimistic concurrency, deterministic
conflict-winner selection, per-type JSONSchema validation, and a changes feed
that supports replication from/to other slouchdb instances.

Built on `node:sqlite` (Node 25+). Synchronous API, no external runtime
dependencies beyond `zod` for schema validation.

## Status

v0 / early work. The core document store, revision model, validator, and
replication primitives are implemented. An HTTP surface and a network
replicator are not — slouchdb is a library today, not a server.

## Install

```sh
npm install slouchdb
```

Requires Node.js 25+ (for native `.ts` execution and built-in
`node:sqlite`).

## Quick start

```ts
import { openStore, put, get, remove } from "slouchdb";
import { validate } from "slouchdb/validate";

const store = openStore("./my.db", { validate });

// Register a schema. Schemas are documents under `_schema/<type>`.
put(store, {
  _id: "_schema/note",
  _type: "_schema",
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
});

// Genesis write.
const a = put(store, { _id: "n1", _type: "note", title: "hello" });

// Extension — must pass the current leaf as `_parent`.
const b = put(store, {
  _id: "n1",
  _type: "note",
  _parent: a._rev,
  title: "hello, world",
});

get(store, "n1");     // -> b (the winning revision)
remove(store, "n1", b._rev);  // tombstone
```

## Concepts

### Revisions

Every write produces a new row. A `_rev` is `"<gen>-<hash>"`:

- `gen` starts at `1` for a genesis write, increments by one per extension.
- `hash` is a content hash over `{_id, _gen, _parent, _type, _deleted, ...data}`.

Identical edits on two replicas converge to the same `_rev`. Identical content
at different generations hashes differently.

### Winner selection

Among the leaves of an `_id` (revisions with no child), the winner is picked
deterministically:

1. Prefer non-deleted over deleted.
2. Then highest generation (compared numerically — gen `11` beats gen `2`).
3. Then lexicographic tiebreak on the hash.

Identical on every replica, so no coordination is required.

### Schemas are documents

Schemas live in the same `documents` table as everything else:

- `_type = "_schema"`, `_id = "_schema/<type-name>"`.
- User data is a JSONSchema object.
- Schemas participate in MVCC and replicate like any other document.
- When a write has `_type = "foo"`, the validator looks up
  `_schema/foo`, compiles it with `z.fromJSONSchema`, and validates the
  user-data portion. The compiled schema is cached by the schema doc's `_rev`
  — content-addressed, so updates invalidate automatically.

If no schema exists for a type, validation is skipped. Rationale: a freshly
replicated database may receive typed documents before their schema has
replicated in. Enforcement kicks in once the schema is known.

### Replication

`bulkInsert` is the replication ingress. It bypasses the leaf check (forks are
intentional), recomputes each revision's hash and rejects tampered rows, and
permits missing ancestors. Schema validation is skipped here — a batch may
carry the schema alongside documents that depend on it, and ingest must not
stall on order.

`changesSince(seq)` is the egress. It returns every revision with
`_local_seq > seq` in order — CouchDB's `style=all_docs` shape. Callers pick
their own checkpoint.

## API

All functions are synchronous, matching `node:sqlite`.

```ts
openStore(path, { validate? }): Store
closeStore(store): void

put(store, { _id, _type?, _parent?, _deleted?, ...data }): Document
remove(store, id, parentRev): Document

get(store, id): Document | undefined          // winning leaf
getRevision(store, rev): Document | undefined // any revision by _rev
getLeaves(store, id): Document[]              // all current leaves
getResolved(store, id): { winner, conflicts } | undefined

bulkInsert(store, docs): { inserted, skipped, rejected }
changesSince(store, since): Document[]

formatRev(gen, hash): string
parseRev(rev): { gen, hash }
```

Errors:

- `ConflictError` — `put` was given a stale or missing `_parent`.
- `ValidationError` — `put` failed schema validation.
- `IntegrityError` — `bulkInsert` recomputed a different hash than the one
  carried in `_rev`.

See [`docs/spec.md`](docs/spec.md) for the full specification.

## Development

```sh
npm run check   # tsc --noEmit
npm test        # node --test src/**/*.test.ts
npm run fmt     # prettier --write
npm run lint    # eslint .
```

## Out of scope for v1

- Revision-tree pruning / stemming (slouchdb keeps every revision).
- Compaction and tombstone purging.
- Attachments.
- View / MapReduce indexes.
- A meta-schema for `_schema` documents.
- HTTP surface and a network replicator.

## License

MIT © Gordon Brander
