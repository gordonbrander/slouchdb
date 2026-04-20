# CouchDB Overview

CouchDB is a document-oriented NoSQL database designed to sync reliably across
unreliable networks. Its name is a backronym for *Cluster Of Unreliable
Commodity Hardware* — the design assumes replicas go offline, fork, and
reconverge, and treats that as the normal case rather than an error.

This document covers the major concepts, document shape, and the technical
details of how conflicts are detected and resolved.

## Major concepts

### Documents

The unit of storage is a JSON document. Documents are self-contained, have no
required schema, and can vary freely in structure from one record to the next.
Each document has a primary key (`_id`) and a revision marker (`_rev`); these
two together identify a specific version of a document.

### HTTP/REST API

CouchDB speaks HTTP natively. Every database, document, attachment, view, and
replication task is a URL. `GET`, `PUT`, `POST`, `DELETE` map directly to CRUD.
There is no separate wire protocol and no mandatory driver — `curl` is a
first-class client.

### MVCC (Multi-Version Concurrency Control)

Updates never overwrite in place. Every write creates a new revision; readers
continue to see the previous revision until they re-read. This means readers
never block writers and writers never block readers. Stale revisions persist
on disk until compaction reclaims them.

### Append-only B-tree storage

The on-disk format is an append-only B-tree. Every write appends new nodes and
a new file header; the latest valid header at the end of the file wins on
recovery. Crashes cannot corrupt earlier state because earlier state is
physically immutable. The trade-off is that files grow monotonically until
compaction rewrites them.

### Views (MapReduce)

Secondary indexes are defined as JavaScript `map` (and optional `reduce`)
functions stored in *design documents*. CouchDB materializes the output into
its own B-tree, updated incrementally as documents change. Views are queried
by key, key range, or reduced aggregate.

### Changes feed

`GET /db/_changes` streams every update to a database in sequence order. It
powers replication, live queries, and reactive clients. The feed can be
long-polled, continuous, or filtered.

### Replication

The headline feature. Replication is incremental, bi-directional, and
peer-to-peer. Any two databases reachable over HTTP can replicate in either
direction. Each database maintains an update sequence; a replicator records
a checkpoint and ships only the changes since the last checkpoint. Replication
survives interruption, works across NAT, and works offline (by queuing until
connectivity returns).

### Eventual consistency

CouchDB offers atomicity at the document level only. There are no multi-
document transactions and no global consistency protocol. The combination of
replication plus deterministic conflict resolution is the consistency story:
any two replicas that have exchanged all updates will agree on the state of
every document, without coordination.

## Document shape

A CouchDB document is a JSON object with a few reserved fields.

```json
{
  "_id": "user:alice",
  "_rev": "3-a1b2c3d4e5f6...",
  "name": "Alice",
  "email": "alice@example.com",
  "tags": ["admin", "beta"]
}
```

### `_id`

The primary key. A UTF-8 string, unique within the database, immutable once
assigned. Clients may supply it or let CouchDB generate a UUID on `POST`.

`_id` is also the B-tree sort key, so range queries over IDs are cheap. It is
common to use natural keys (`user:alice`, `2026-04-20-post-slug`) to make
`_all_docs` range scans useful.

Reserved prefixes:

- `_design/<name>` — *design documents*: contain view definitions, validation
  functions, update handlers. Indexed and processed specially.
- `_local/<name>` — *local documents*: never replicate. Used for per-replica
  state (e.g. replication checkpoints).

### `_rev`

The revision identifier, formatted `N-hash`.

- `N` is an integer generation counter, starting at 1.
- `hash` is derived deterministically from the document content and its
  parent revision.

`_rev` is the optimistic-concurrency token: every update must submit the
current `_rev` or the server returns `409 Conflict`. `_rev` is assigned by
the server, not the client.

### Revision tree

A document is not a linear chain of revisions but a *tree*. Normal updates
extend one branch. Conflicting updates across replicas create forks. CouchDB
stores the full tree topology (intermediate bodies may be pruned by
compaction, but the structure is preserved) so that replication can reason
about which revisions a peer is missing.

### Attachments

Binary blobs can be stored alongside a document under `_attachments`. They
are fetched at `/db/{id}/{attname}` and participate in replication.

### Deleted documents

A delete is a write, not a removal. The tombstone is a revision with
`_deleted: true` and is kept so replicas can learn about the deletion. Only
compaction eventually purges it.

## Conflict resolution

Conflicts are first-class data in CouchDB. Understanding them is essential to
using the system correctly.

### How conflicts arise

A conflict exists when a document has more than one *leaf* revision — a
revision that is not an ancestor of any other revision. There are two paths
to this state:

1. **Direct write conflict (single database).** Clients A and B both read
   revision `1-abc`. A writes and produces `2-xxx`. B attempts to write with
   `_rev: 1-abc` and receives `409 Conflict`. B must re-read and retry. The
   fork is *not* persisted; the database always has a single leaf after a
   direct write.

2. **Replication conflict (across databases).** A writes `2-xxx` on replica
   1. B writes `2-yyy` on replica 2 while offline. When the replicas sync,
   both revisions now exist in both databases. The fork *is* persisted;
   replication never discards revisions.

The asymmetry is intentional: a single database enforces linear history;
replication preserves every writer's intent. This is what makes CouchDB
usable for offline-first applications.

### Deterministic winner selection

When multiple leaves exist, CouchDB picks one as the *winning* revision using
an algorithm that is identical on every replica:

1. Prefer non-deleted leaves over deleted ones.
2. Among the remaining leaves, pick the one with the highest generation
   number `N`.
3. If still tied, break by lexicographically comparing the revision hashes.

Because the inputs (the set of leaves) converge across replicas after
replication, and the algorithm is deterministic, every replica independently
selects the same winner without any coordination protocol. A plain
`GET /db/doc` returns the winner; most reads never need to know conflicts
exist.

### Detecting conflicts

- `GET /db/doc?conflicts=true` — returns the winning document plus a
  `_conflicts` array listing the `_rev`s of the losing leaves.
- `GET /db/doc?open_revs=all` — returns every leaf revision in full, not just
  the winner.
- `GET /db/_changes?style=all_docs` — includes every leaf of each changed
  document, so subscribers can see conflicts as they emerge.
- A *view* can emit on `doc._conflicts`, producing a materialized "conflicts
  inbox" for an application to work through.

### Resolving conflicts

Resolution is the application's responsibility. CouchDB will not guess. The
standard procedure:

1. Fetch the winning revision and all conflicting revisions
   (`?open_revs=all`).
2. Merge them using domain logic — last-write-wins by timestamp, field-level
   merge, CRDT-style union, user prompt, or whatever fits.
3. `PUT` the merged document as a new revision extending the winning branch.
4. `DELETE` each losing revision by submitting `{_deleted: true, _rev:
   <loser>}` for it.

Step 4 is load-bearing. Until every loser is tombstoned, the document remains
"in conflict" and `_conflicts` keeps returning it. Missing this step is the
most common CouchDB bug.

### Design implications

- **Model to avoid conflicts.** Smaller, more granular documents conflict
  less often than large aggregates. Append-only patterns — emitting new
  event documents with unique IDs rather than mutating a shared one — never
  conflict at all.
- **Conflicts are not errors.** Ignoring them yields a consistent-looking
  database (the winner algorithm guarantees agreement). Resolve only when
  silently dropping the losing writes would be semantically wrong.
- **Replication preserves intent, not invariants.** Two offline users editing
  the same document will both succeed and both edits will survive the round
  trip. If your correctness depends on one of them being rejected, CouchDB
  is not the tool.
- **Per-document atomicity only.** Invariants that span multiple documents
  cannot be enforced by the database. Either denormalize into a single
  document or accept that the invariant is advisory.

## Further reading

- Official docs: <https://docs.couchdb.org/>
- Apache CouchDB: The Definitive Guide: <https://guide.couchdb.org/>
