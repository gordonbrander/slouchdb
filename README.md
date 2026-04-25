# slouchdb

CouchDB, but for SQLite. A local, embeddable document store with CouchDB
semantics — revision trees, optimistic concurrency, deterministic
conflict-winner selection, and a changes feed that supports replication
from/to other slouchdb instances. Optional per-type JSONSchema validation is
available as a separate, opt-in helper.

Built on `node:sqlite` (Node 25+). Synchronous API, no external runtime
dependencies beyond `zod` (used only by the optional validation helper).

## Status

v0 / early work. The core document store, revision model, conflict
resolution, and replication primitives are implemented. An HTTP surface and a
network replicator are not — slouchdb is a library today, not a server.

## Install

```sh
npm install slouchdb
```

Requires Node.js 25+ (for native `.ts` execution and built-in
`node:sqlite`).

## Quick start

```ts
import { openStore, put, get, remove } from "slouchdb";

const store = openStore("./my.db");

// Genesis write.
const a = put(store, { _id: "n1", _type: "note", title: "hello" });

// Extension — must pass the current leaf as `_parent`.
const b = put(store, {
  _id: "n1",
  _type: "note",
  _parent: a._rev,
  title: "hello, world",
});

get(store, "n1"); // -> b (the winning revision)
remove(store, "n1", b._rev); // tombstone
```

### Validation (opt-in)

Validation is decoupled from the store. Register a schema, then call
`getSchema` and validate yourself before writing:

```ts
import { put } from "slouchdb";
import { getSchema, putSchema } from "slouchdb/validate";
import * as z from "zod/v4";

putSchema(store, "note", z.object({ title: z.string() }));

const schema = getSchema(store, "note");
const parsed = schema?.safeParse({ title: "hello" });
if (!parsed?.success) throw parsed?.error;

put(store, { _id: "n1", _type: "note", ...parsed.data });
```

`put` itself does no schema validation — keeping the store agnostic means
replication never stalls because a schema hasn't arrived yet, and callers
choose when (or whether) to enforce.

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

### Conflict resolution

When an `_id` has more than one live leaf, `resolve(store, id, reconcile)`
merges them: the reconciler is called with `[winner, ...losers]` in canonical
order, its return value is written as a child of the winner, and every losing
live leaf is tombstoned in the same transaction. Two replicas running the
same reconciler over the same leaves produce the same merge `_rev`.

### Schemas are documents

Schemas live in the same `documents` table as everything else:

- `_type = "_schema"`, `_id = "_schema/<type-name>"`.
- User data is a JSONSchema object.
- Schemas participate in MVCC and replicate like any other document.
- `getSchema(store, type)` looks up `_schema/<type>`, compiles it with
  `z.fromJSONSchema`, and caches the compiled schema by the schema doc's
  `_rev` — content-addressed, so updates invalidate automatically.

If no schema exists for a type, `getSchema` returns `undefined`. A freshly
replicated database may receive typed documents before their schema has
replicated in; enforcement is the caller's choice.

### Replication

`bulkInsert` is the replication ingress. It bypasses the leaf check (forks are
intentional), recomputes each revision's hash and rejects tampered rows, and
permits missing ancestors.

`changesSince(seq)` is the egress. It returns every revision with
`_local_seq > seq` in order — CouchDB's `style=all_docs` shape. Callers pick
their own checkpoint.

## API

All functions are synchronous, matching `node:sqlite`. `Store` is just a
`node:sqlite` `DatabaseSync`.

### `slouchdb` (re-exports `./store` and `./errors`)

```ts
openStore(path): Store
closeStore(store): void

put(store, { _id, _type?, _parent?, _deleted?, ...data }): Document
remove(store, id, parentRev): Document

get(store, id): Document | undefined            // winning leaf
getRevision(store, rev): Document | undefined   // any revision by _rev
getRevisionBulk(store, revs): { documents, missing }
getLeaves(store, id): Document[]                // all current leaves
getResolved(store, id): Resolved | undefined    // winner + conflicts split
getHistory(store, id, rev?): Document[]         // leaf-to-root walk

bulkInsert(store, docs): { inserted, skipped, rejected }
changesSince(store, since): Document[]

formatRev(gen, hash): string
parseRev(rev): { gen, hash }
revisionHash({ _id, _gen, _parent, _type, _deleted, data }): string
extractData(doc): Record<string, unknown>       // strip reserved fields
RESERVED: ReadonlySet<string>                   // reserved field names
```

`Resolved` is `{ winner, conflicts, deletedConflicts }`, mirroring CouchDB's
`?conflicts=true` (`_conflicts`) and `?deleted_conflicts=true`
(`_deleted_conflicts`) read shapes. A document is "in conflict" exactly when
`conflicts.length > 0`.

### `slouchdb/resolve`

```ts
import { resolve, type Reconciler } from "slouchdb/resolve";

resolve(store, id, reconcile): Document | undefined
```

### `slouchdb/validate`

```ts
import { getSchema, putSchema, clearSchemaCache } from "slouchdb/validate";

getSchema(store, type): z.ZodType | undefined
putSchema(store, type, zodSchema, _parent?): Document
clearSchemaCache(): void   // test-only
```

### `slouchdb/errors`

- `ConflictError` — `put` was given a stale or missing `_parent`.
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
