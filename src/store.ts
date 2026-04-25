import { type DatabaseSync } from "node:sqlite";
import { cid } from "./cid.ts";
import { ConflictError, IntegrityError } from "./errors.ts";
import { openDatabase, savepoint } from "./sqlite.ts";

/** The authoritative set of reserved field names. */
export const RESERVED: ReadonlySet<string> = new Set([
  "_id",
  "_rev",
  "_parent",
  "_type",
  "_deleted",
  "_local_seq",
]);

/** A flat document: reserved fields + arbitrary user data fields. */
export type Document = {
  _local_seq: number;
  _rev: string;
  _id: string;
  _parent: string | undefined;
  _type: string | undefined;
  _deleted: boolean;
  [field: string]: unknown;
};

/** Input to {@link put}. Unknown reserved fields are ignored. */
export type PutInput = {
  _id: string;
  _type?: string;
  _parent?: string;
  _deleted?: boolean;
  [field: string]: unknown;
};

/** Input to {@link bulkInsert}. Carries a pre-computed `_rev`. */
export type BulkDocument = {
  _id: string;
  _rev: string;
  _parent?: string;
  _type?: string;
  _deleted?: boolean;
  [field: string]: unknown;
};

/**
 * Read shape for a multi-leaf document: deterministically chosen `winner`
 * plus the `_rev`s of every other leaf, split by deletion status. Mirrors
 * CouchDB's `?conflicts=true` and `?deleted_conflicts=true` projections.
 * The doc is "in conflict" exactly when `conflicts.length > 0`.
 */
export type Resolved = {
  winner: Document;
  /** Live (non-tombstone) leaf revs other than the winner. CouchDB `_conflicts`. */
  conflicts: string[];
  /** Tombstone leaf revs. CouchDB `_deleted_conflicts`. */
  deletedConflicts: string[];
};

/**
 * Result of {@link getRevisionBulk}: matched rows in input order plus any
 * input revs that had no row.
 */
export type GetRevisionBulkReceipt = {
  documents: Document[];
  missing: string[];
};

/**
 * Result of {@link bulkInsert}. `inserted` and `skipped` (already-seen
 * `_rev`s, deduped via `INSERT OR IGNORE`) sum to the number of well-formed
 * input rows; integrity-check failures land in `rejected` instead.
 */
export type BulkResult = {
  inserted: number;
  skipped: number;
  rejected: Array<{ rev: string; reason: string }>;
};

/** Opaque handle to an open slouchdb store. Backed by `node:sqlite`. */
export type Store = DatabaseSync;

const migrations: readonly string[] = [
  `
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
  `,
];

/**
 * Open or create a slouchdb store at `path`. Pass `":memory:"` for an
 * in-memory database. Migrations are applied on first open of a fresh DB
 * and are no-ops on reopen.
 */
export const openStore = (path: string): Store =>
  openDatabase(path, migrations);

/** Close the underlying SQLite connection. */
export const closeStore = (store: Store): void => {
  store.close();
};

type Row = {
  _local_seq: number;
  _rev: string;
  _id: string;
  _parent: string | null;
  _type: string | null;
  _deleted: number;
  data: string;
};

/** Compose a `_rev` string from a generation and bare hash. */
export const formatRev = (gen: number, hash: string): string =>
  `${gen}-${hash}`;

/** Parse a `_rev` string into its generation and bare hash. */
export const parseRev = (rev: string): { gen: number; hash: string } => {
  const i = rev.indexOf("-");
  if (i <= 0) throw new Error(`malformed _rev: ${JSON.stringify(rev)}`);
  const gen = Number(rev.slice(0, i));
  if (!Number.isInteger(gen) || gen < 1) {
    throw new Error(`malformed _rev generation: ${JSON.stringify(rev)}`);
  }
  return { gen, hash: rev.slice(i + 1) };
};

/** Return a copy of `doc` with all reserved keys removed. */
export const extractData = (
  doc: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc)) {
    if (!RESERVED.has(k)) out[k] = doc[k];
  }
  return out;
};

const rowToDocument = (row: Row): Document => {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {
    _local_seq: row._local_seq,
    _rev: row._rev,
    _id: row._id,
    _parent: row._parent ?? undefined,
    _type: row._type ?? undefined,
    _deleted: row._deleted === 1,
    ...data,
  };
};

/**
 * Compute the content hash for a revision. Returns the bare hash; callers
 * compose the full `_rev` via {@link formatRev}. Normalizes `undefined`
 * parent and type to `null` so presence/absence is unambiguous in the hash
 * input. `_local_seq` is intentionally excluded — it varies by replica.
 */
export const revisionHash = (input: {
  _id: string;
  _gen: number;
  _parent: string | undefined;
  _type: string | undefined;
  _deleted: boolean;
  data: Record<string, unknown>;
}): string =>
  cid({
    _id: input._id,
    _gen: input._gen,
    _parent: input._parent ?? null,
    _type: input._type ?? null,
    _deleted: input._deleted,
    ...input.data,
  });

const leavesByIdStmt = (db: DatabaseSync) =>
  db.prepare(`
    SELECT d.* FROM documents d
    WHERE d._id = ?
      AND NOT EXISTS (SELECT 1 FROM documents c WHERE c._parent = d._rev)
  `);

const insertStmt = (db: DatabaseSync) =>
  db.prepare(`
    INSERT OR IGNORE INTO documents
      (_rev, _id, _parent, _type, _deleted, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

const getByRevStmt = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM documents WHERE _rev = ?");

const changesStmt = (db: DatabaseSync) =>
  db.prepare(
    "SELECT * FROM documents WHERE _local_seq > ? ORDER BY _local_seq",
  );

/**
 * Optimistic-concurrency write. `_parent` must be a current leaf of `_id`
 * (or unset when `_id` has no existing revisions). Throws
 * {@link ConflictError} on stale or missing parent. Idempotent: if the
 * computed `_rev` already exists, the existing row is returned without
 * inserting.
 */
export const put = (store: Store, input: PutInput): Document => {
  const _id = input._id;
  const _type = input._type;
  const _parent = input._parent;
  const _deleted = input._deleted ?? false;
  const data = extractData(input);

  return savepoint(store, "put", () => {
    const leaves = leavesByIdStmt(store).all(_id) as Row[];

    const _gen = _parent === undefined ? 1 : parseRev(_parent).gen + 1;
    const hash = revisionHash({ _id, _gen, _parent, _type, _deleted, data });
    const _rev = formatRev(_gen, hash);

    const existing = getByRevStmt(store).get(_rev) as Row | undefined;
    if (existing) return rowToDocument(existing);

    if (_parent === undefined) {
      if (leaves.length > 0) {
        throw new ConflictError(
          _id,
          undefined,
          leaves.map((l) => l._rev),
        );
      }
    } else if (!leaves.some((l) => l._rev === _parent)) {
      throw new ConflictError(
        _id,
        _parent,
        leaves.map((l) => l._rev),
      );
    }

    insertStmt(store).run(
      _rev,
      _id,
      _parent ?? null,
      _type ?? null,
      _deleted ? 1 : 0,
      JSON.stringify(data),
    );

    const row = getByRevStmt(store).get(_rev) as Row;
    return rowToDocument(row);
  });
};

/** Create a tombstone extending `parentRev`. */
export const remove = (store: Store, id: string, parentRev: string): Document =>
  put(store, { _id: id, _parent: parentRev, _deleted: true });

/**
 * The winning leaf per the CouchDB algorithm:
 *   prefer non-deleted, then highest generation, then lexicographic hash.
 * Tombstones ARE returned when no non-deleted leaf exists; callers check
 * `._deleted`.
 */
export const get = (store: Store, id: string): Document | undefined => {
  const row = store
    .prepare(
      `
      SELECT d.* FROM documents d
      WHERE d._id = ?
        AND NOT EXISTS (SELECT 1 FROM documents c WHERE c._parent = d._rev)
      ORDER BY d._deleted ASC, d._rev_gen DESC, d._rev_hash ASC
      LIMIT 1
    `,
    )
    .get(id) as Row | undefined;
  return row ? rowToDocument(row) : undefined;
};

/** Fetch a specific revision by `_rev`, whether leaf or internal. */
export const getRevision = (
  store: Store,
  rev: string,
): Document | undefined => {
  const row = getByRevStmt(store).get(rev) as Row | undefined;
  return row ? rowToDocument(row) : undefined;
};

/** All current leaves for `_id`. Multiple leaves ⇒ the document is in conflict. */
export const getLeaves = (store: Store, id: string): Document[] => {
  const rows = leavesByIdStmt(store).all(id) as Row[];
  return rows.map(rowToDocument);
};

/**
 * Winner plus the `_rev`s of all other leaves, split by deletion status.
 * Mirrors CouchDB's `?conflicts=true` (`_conflicts`) and
 * `?deleted_conflicts=true` (`_deleted_conflicts`) read shapes. The doc
 * is "in conflict" exactly when `conflicts.length > 0`. Undefined if
 * the id is absent.
 */
export const getResolved = (store: Store, id: string): Resolved | undefined => {
  const leaves = getLeaves(store, id);
  if (leaves.length === 0) return undefined;
  const decorated = leaves.map((doc) => ({ doc, parsed: parseRev(doc._rev) }));
  decorated.sort((a, b) => {
    if (a.doc._deleted !== b.doc._deleted) return a.doc._deleted ? 1 : -1;
    if (a.parsed.gen !== b.parsed.gen) return b.parsed.gen - a.parsed.gen;
    return a.parsed.hash < b.parsed.hash
      ? -1
      : a.parsed.hash > b.parsed.hash
        ? 1
        : 0;
  });
  const [winner, ...rest] = decorated;
  const conflicts: string[] = [];
  const deletedConflicts: string[] = [];
  for (const r of rest) {
    (r.doc._deleted ? deletedConflicts : conflicts).push(r.doc._rev);
  }
  return { winner: winner.doc, conflicts, deletedConflicts };
};

/**
 * Fetch many revisions in one round-trip. Returns matched documents in
 * input order alongside any input revs that had no row. Duplicate revs in
 * the input are duplicated in `documents` (when found) but appear once in
 * `missing` (when absent). Empty input returns empty receipt without
 * touching the database.
 */
export const getRevisionBulk = (
  store: Store,
  revs: readonly string[],
): GetRevisionBulkReceipt => {
  if (revs.length === 0) return { documents: [], missing: [] };
  const placeholders = revs.map(() => "?").join(",");
  const rows = store
    .prepare(`SELECT * FROM documents WHERE _rev IN (${placeholders})`)
    .all(...revs) as Row[];
  const byRev = new Map(rows.map((r) => [r._rev, r]));
  const documents: Document[] = [];
  const missingSet = new Set<string>();
  const missing: string[] = [];
  for (const rev of revs) {
    const row = byRev.get(rev);
    if (row) {
      documents.push(rowToDocument(row));
    } else if (!missingSet.has(rev)) {
      missingSet.add(rev);
      missing.push(rev);
    }
  }
  return { documents, missing };
};

/**
 * Walk the parent chain from a leaf back to the root. Default starting
 * revision is the winner of `id`. Returns documents in leaf-to-root order
 * (start first, root last). Stops at the first missing ancestor (relevant
 * once revision-tree pruning lands). Returns an empty array if `id` is
 * unknown, if the supplied `rev` is unknown, or if the supplied `rev`
 * belongs to a different document.
 */
export const getHistory = (
  store: Store,
  id: string,
  rev?: string,
): Document[] => {
  const startRev = rev ?? get(store, id)?._rev;
  if (startRev === undefined) return [];
  const out: Document[] = [];
  const stmt = getByRevStmt(store);
  let cursor: string | undefined = startRev;
  while (cursor !== undefined) {
    const row = stmt.get(cursor) as Row | undefined;
    if (!row || row._id !== id) break;
    const doc = rowToDocument(row);
    out.push(doc);
    cursor = doc._parent;
  }
  return out;
};

/**
 * Replication ingress. Bypasses the leaf check — forks are intentional.
 * Each doc's `_rev` is reparsed and its hash recomputed from the supplied
 * fields; mismatches are rejected (tracked in the result, not thrown).
 * Missing ancestors are permitted.
 */
export const bulkInsert = (
  store: Store,
  docs: readonly BulkDocument[],
): BulkResult => {
  const result: BulkResult = { inserted: 0, skipped: 0, rejected: [] };

  return savepoint(store, "bulk_insert", () => {
    const stmt = insertStmt(store);
    for (const doc of docs) {
      const data = extractData(doc);
      const _deleted = doc._deleted ?? false;

      let parsed: { gen: number; hash: string };
      try {
        parsed = parseRev(doc._rev);
      } catch (err) {
        result.rejected.push({
          rev: doc._rev,
          reason: (err as Error).message,
        });
        continue;
      }

      const computed = revisionHash({
        _id: doc._id,
        _gen: parsed.gen,
        _parent: doc._parent,
        _type: doc._type,
        _deleted,
        data,
      });
      if (computed !== parsed.hash) {
        result.rejected.push({
          rev: doc._rev,
          reason: new IntegrityError(parsed.hash, computed).message,
        });
        continue;
      }
      const info = stmt.run(
        doc._rev,
        doc._id,
        doc._parent ?? null,
        doc._type ?? null,
        _deleted ? 1 : 0,
        JSON.stringify(data),
      );
      if (info.changes === 1) result.inserted++;
      else result.skipped++;
    }
    return result;
  });
};

/** All revisions with `_local_seq > since`, in order. Drives replication. */
export const changesSince = (store: Store, since: number): Document[] => {
  const rows = changesStmt(store).all(since) as Row[];
  return rows.map(rowToDocument);
};
