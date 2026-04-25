# CouchDB's Model of Conflict Resolution

## The core idea

CouchDB treats conflict resolution as an **application concern, not a
database concern**. The database's job is to (a) accept writes
optimistically without coordination, (b) preserve every divergent branch
of history that arises from offline edits and replication, and (c) give
applications a deterministic, consistent view of that divergence so they
can resolve it however their business logic demands. The database never
discards data to "fix" a conflict; only the application can decide what
the merged truth should be.

This is what makes CouchDB an offline-first, multi-master system: every
replica can accept writes independently, replicate with its peers in any
order, and end up in a state where all replicas agree on what the
conflicts are even if no one has resolved them yet.

## Writes are optimistic and local

Each document has a revision tree. A `put` extends the tree by attaching
a new revision to a parent revision. The write succeeds locally if the
specified parent is a current **leaf** of the tree (i.e. no other
revision has it as a parent yet). If the parent is no longer a leaf —
because some other writer or a replication batch has already extended
that branch — the write is rejected with a 409 Conflict and the
application must re-read, re-base, and retry.

Crucially, this leaf check only applies to _local_ writes. Replication
uses a different ingest path (`_bulk_docs` with `new_edits=false` in
CouchDB; `bulkInsert` in slouchdb) that **bypasses the leaf check
entirely**. Replication's job is to transplant revisions from another
replica's tree into ours, branches and all. If two replicas wrote
independently against the same parent, replication will land both as
sibling leaves under that parent. This is not an error — it is the
mechanism by which the system tolerates partition and offline editing.

The result: after replication, a document can have **multiple live
leaves**. Each leaf is a valid, application-authored revision; they
simply diverge from a common ancestor. This is the conflict.

## Revisions, generations, and deterministic ordering

A revision identifier is structured as `<gen>-<hash>`, where `gen` is
the depth in the revision tree (1 for the first revision, incrementing
by one per child) and `hash` is a content hash that distinguishes
siblings within the same generation. The hash is computed over the
document body and the parent reference, so any two replicas that
construct the same revision from the same parent and the same content
will arrive at the same `_rev`. This is what lets replication recognize
"we already have this revision" rather than duplicating it.

When a document has multiple live leaves, CouchDB picks one as the
**winner** using a deterministic ordering: live (non-deleted) revisions
beat tombstones, then highest generation wins, then highest hash
lexicographically as a tiebreak. Because every replica has the same
leaves after replication and applies the same ordering, **every replica
independently picks the same winner**. No coordination is required.

This is a subtle but important property: even before any application
reconciliation has happened, the system is _consistent_ in the sense
that every replica agrees on which revision is the current "default"
view of the document. It is just not yet _merged_ — the losing leaves
are still in the tree, still replicated, still readable, and still
waiting for the application to do something about them.

## Reads surface conflicts; they do not resolve them

Reads are pure. They never mutate the revision tree.

The default read returns just the winning revision, so a naive client
sees a single coherent document and is unaware that conflicts exist.
This is intentional: most readers don't care, and the deterministic
winner is a reasonable default. Clients that _do_ care request conflicts
explicitly (in CouchDB, `?conflicts=true`), which returns the winner
plus the revision identifiers of the losing leaves. The losing
revisions can then be fetched individually by `_rev`.

The read API is the surface through which conflicts become visible to
applications. The data model itself doesn't distinguish between "in
conflict" and "not in conflict" — there is just a tree with one or more
leaves. A document is "in conflict" exactly when it has more than one
live leaf, and the read API lets a client discover this.

## Reconciliation is application logic, expressed as more writes

Reconciliation is not a special operation in the data model. It is just
a sequence of normal writes that the application performs after reading
the conflicting leaves:

1. **Read all the leaves.** Use the conflicts-aware read to get the
   winner and the losing-leaf revisions; fetch each losing leaf by
   `_rev`.
2. **Compute the merged document** using whatever business logic is
   appropriate for that document type. Last-write-wins, field-level
   merge, set union, user-prompted choice — the database has no opinion.
3. **Write the merged document** with `_parent` set to one of the
   leaves' `_rev`s. This extends that branch with a new revision.
4. **Tombstone the other leaves.** For each remaining live leaf, write
   a `_deleted: true` revision with `_parent` set to that leaf's `_rev`.
   This caps the branch with a dead leaf so it no longer competes for
   winner selection.

After step 4, the tree still contains all of history (the losing
branches are still there, terminating in tombstones), but only one
_live_ leaf remains, so the winner is unambiguous and there are no
remaining conflicts to surface on read.

Because reconciliation is just more writes, it replicates like any
other write. When the resolving replica syncs with its peers, the merge
revision and the tombstones flow through replication and every other
replica converges on the same resolved state. Two replicas can even
race to resolve the same conflict; the result is a new, smaller
conflict (two merge revisions as siblings), which the application can
resolve again by the same mechanism. The system always makes forward
progress.

## Two layers of "eventual consistency"

The phrase "eventual consistency" papers over two distinct guarantees
that CouchDB provides at different timescales:

- **Immediate, automatic agreement on the winner.** As soon as
  replication has delivered the same set of leaves to two replicas,
  those replicas agree on which leaf wins the deterministic ordering.
  This requires no application action and no coordination. Readers on
  any replica see the same default view.
- **Eventual, application-driven convergence on a single live leaf.**
  The losing branches persist until _some_ replica's application logic
  reconciles them and writes the merge plus tombstones. Once that
  resolution replicates, every replica has a single live leaf and the
  document is no longer in conflict anywhere.

The first guarantee is what lets CouchDB-based systems remain usable
during partition and divergence: there is always a coherent, consistent
answer to "what is the current version of this document?" even when
conflicts exist. The second guarantee is what lets the system actually
_progress_ toward a merged state, on a timescale that matches the
application's tolerance for handling conflicts.

## Why this design is the right shape for offline-first

The model trades a richer database (one that auto-merges) for a smaller,
more predictable one (one that preserves history and lets applications
merge). The benefits:

- **Replicas can accept writes without coordination.** No quorum, no
  leader election, no locking. A laptop offline for a week can keep
  writing.
- **No data is ever silently lost.** Every divergent edit survives in
  the revision tree until an application explicitly resolves it.
  Compare this with last-write-wins systems where a clock skew or a
  late arrival can erase a real edit.
- **Resolution logic lives where the domain knowledge is.** The
  database can't know that two edits to a shopping cart should union
  their line items, or that two edits to a counter should sum, or that
  two edits to a title should prompt the user. The application does
  know, and the model puts the resolution there.
- **Replicas converge deterministically even before resolution.**
  Because winner selection is a pure function of the leaves, every
  replica picks the same winner, so reads are coherent across the
  cluster even mid-conflict.

The cost is that applications must opt into conflict awareness — they
must request conflicts on read and write resolution logic. For
applications that don't need it, the deterministic winner is a sensible
default and they can ignore the rest. For applications that do, the
machinery is exposed and orthogonal: conflicts are visible, history is
preserved, and reconciliation is just more writes.
