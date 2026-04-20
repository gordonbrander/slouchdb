import { type DatabaseSync } from "node:sqlite";
import { cid } from "./cid.ts";
import { ConflictError, IntegrityError } from "./errors.ts";
import { openDatabase } from "./sqlite.ts";

/** The authoritative set of reserved field names. */
export const RESERVED: ReadonlySet<string> = new Set([
  "_id",
  "_hash",
  "_gen",
  "_parent",
  "_type",
  "_deleted",
  "_seq",
  "_createdAt",
]);

/** A flat document: reserved fields + arbitrary user data fields. */
export type Document = {
  _id: string;
  _hash: string;
  _gen: number;
  _parent: string | undefined;
  _type: string | undefined;
  _deleted: boolean;
  _seq: number;
  _createdAt: number;
  [field: string]: unknown;
};

/** The doc-shape passed to a validator, before DB-assigned fields are set. */
export type PendingDocument = Omit<Document, "_seq" | "_createdAt">;

/** Input to {@link put}. Unknown reserved fields are ignored. */
export type PutInput = {
  _id: string;
  _type?: string;
  _parent?: string;
  _deleted?: boolean;
  [field: string]: unknown;
};

/** Input to {@link bulkInsert}. Carries pre-computed reserved fields. */
export type BulkDocument = {
  _id: string;
  _hash: string;
  _gen: number;
  _parent?: string;
  _type?: string;
  _deleted?: boolean;
  _createdAt: number;
  [field: string]: unknown;
};

export type Resolved = {
  winner: Document;
  conflicts: string[];
};

export type BulkResult = {
  inserted: number;
  skipped: number;
  rejected: Array<{ hash: string; reason: string }>;
};

export type Validator = (
  store: Store,
  type: string,
  doc: PendingDocument,
) => void;

export type Store = {
  db: DatabaseSync;
  validate: Validator;
};

const noValidator: Validator = () => {};

const migrations: readonly string[] = [
  `
    CREATE TABLE documents (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      hash        TEXT UNIQUE NOT NULL,
      key         TEXT NOT NULL,
      generation  INTEGER NOT NULL,
      parent_hash TEXT,
      type        TEXT,
      data        TEXT NOT NULL,
      deleted     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX documents_key_idx ON documents(key);
    CREATE INDEX documents_parent_idx ON documents(parent_hash);
  `,
];

export const openStore = (
  path: string,
  opts?: { validate?: Validator },
): Store => ({
  db: openDatabase(path, migrations),
  validate: opts?.validate ?? noValidator,
});

export const closeStore = (store: Store): void => {
  store.db.close();
};

type Row = {
  seq: number;
  hash: string;
  key: string;
  generation: number;
  parent_hash: string | null;
  type: string | null;
  data: string;
  deleted: number;
  created_at: number;
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
    _id: row.key,
    _hash: row.hash,
    _gen: row.generation,
    _parent: row.parent_hash ?? undefined,
    _type: row.type ?? undefined,
    _deleted: row.deleted === 1,
    _seq: row.seq,
    _createdAt: row.created_at,
    ...data,
  };
};

/**
 * Compute the content hash for a revision. Normalizes `undefined` parent
 * and type to `null` so presence/absence is unambiguous in the hash input.
 * `_seq` and `_createdAt` are intentionally excluded — they vary by replica.
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
    WHERE d.key = ?
      AND NOT EXISTS (SELECT 1 FROM documents c WHERE c.parent_hash = d.hash)
  `);

const insertStmt = (db: DatabaseSync) =>
  db.prepare(`
    INSERT OR IGNORE INTO documents
      (hash, key, generation, parent_hash, type, data, deleted, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

const getByHashStmt = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM documents WHERE hash = ?");

const changesStmt = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM documents WHERE seq > ? ORDER BY seq");

/**
 * Optimistic-concurrency write. `_parent` must be a current leaf of `_id`
 * (or unset when `_id` has no existing revisions). Throws
 * {@link ConflictError} on stale or missing parent. Idempotent: if the
 * computed `_hash` already exists, the existing row is returned without
 * inserting.
 */
export const put = (store: Store, input: PutInput): Document => {
  const { db } = store;
  const _id = input._id;
  const _type = input._type;
  const _parent = input._parent;
  const _deleted = input._deleted ?? false;
  const data = extractData(input);

  db.exec("BEGIN IMMEDIATE");
  try {
    const leaves = leavesByIdStmt(db).all(_id) as Row[];

    let _gen: number;
    if (_parent === undefined) {
      _gen = 1;
    } else {
      const parent = db
        .prepare("SELECT * FROM documents WHERE hash = ? AND key = ?")
        .get(_parent, _id) as Row | undefined;
      if (!parent) {
        throw new ConflictError(
          _id,
          _parent,
          leaves.map((l) => l.hash),
        );
      }
      _gen = parent.generation + 1;
    }

    const _hash = revisionHash({ _id, _gen, _parent, _type, _deleted, data });

    const existing = getByHashStmt(db).get(_hash) as Row | undefined;
    if (existing) {
      db.exec("COMMIT");
      return rowToDocument(existing);
    }

    if (_type !== undefined && _type !== "_schema") {
      const pending: PendingDocument = {
        _id,
        _hash,
        _gen,
        _parent,
        _type,
        _deleted,
        ...data,
      };
      store.validate(store, _type, pending);
    }

    if (_parent === undefined) {
      if (leaves.length > 0) {
        throw new ConflictError(
          _id,
          undefined,
          leaves.map((l) => l.hash),
        );
      }
    } else if (!leaves.some((l) => l.hash === _parent)) {
      throw new ConflictError(
        _id,
        _parent,
        leaves.map((l) => l.hash),
      );
    }

    insertStmt(db).run(
      _hash,
      _id,
      _gen,
      _parent ?? null,
      _type ?? null,
      JSON.stringify(data),
      _deleted ? 1 : 0,
      Date.now(),
    );

    const row = getByHashStmt(db).get(_hash) as Row;
    db.exec("COMMIT");
    return rowToDocument(row);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

/** Create a tombstone extending `parent`. */
export const remove = (
  store: Store,
  id: string,
  parent: string,
): Document => put(store, { _id: id, _parent: parent, _deleted: true });

/**
 * The winning leaf per the CouchDB algorithm:
 *   prefer non-deleted, then highest `_gen`, then lexicographic `_hash`.
 * Tombstones ARE returned when no non-deleted leaf exists; callers check
 * `._deleted`.
 */
export const get = (store: Store, id: string): Document | undefined => {
  const row = store.db
    .prepare(
      `
      SELECT d.* FROM documents d
      WHERE d.key = ?
        AND NOT EXISTS (SELECT 1 FROM documents c WHERE c.parent_hash = d.hash)
      ORDER BY d.deleted ASC, d.generation DESC, d.hash ASC
      LIMIT 1
    `,
    )
    .get(id) as Row | undefined;
  return row ? rowToDocument(row) : undefined;
};

/** Fetch a specific revision by `_hash`, whether leaf or internal. */
export const getRevision = (
  store: Store,
  hash: string,
): Document | undefined => {
  const row = getByHashStmt(store.db).get(hash) as Row | undefined;
  return row ? rowToDocument(row) : undefined;
};

/** All current leaves for `_id`. Multiple leaves ⇒ the document is in conflict. */
export const getLeaves = (store: Store, id: string): Document[] => {
  const rows = leavesByIdStmt(store.db).all(id) as Row[];
  return rows.map(rowToDocument);
};

/**
 * Winner plus the hashes of all other leaves. Matches CouchDB's
 * `?conflicts=true` read shape. Undefined if the id is absent.
 */
export const getResolved = (store: Store, id: string): Resolved | undefined => {
  const leaves = getLeaves(store, id);
  if (leaves.length === 0) return undefined;
  const sorted = [...leaves].sort((a, b) => {
    if (a._deleted !== b._deleted) return a._deleted ? 1 : -1;
    if (a._gen !== b._gen) return b._gen - a._gen;
    return a._hash < b._hash ? -1 : a._hash > b._hash ? 1 : 0;
  });
  const [winner, ...rest] = sorted;
  return { winner, conflicts: rest.map((r) => r._hash) };
};

/**
 * Replication ingress. Bypasses the leaf check — forks are intentional.
 * Each doc's `_hash` is recomputed and compared; mismatches are rejected
 * (tracked in the result, not thrown). Missing ancestors are permitted.
 * Schema validation is not run here: a batch may carry the schema
 * alongside data that depends on it, and ingest must not stall on order.
 */
export const bulkInsert = (
  store: Store,
  docs: readonly BulkDocument[],
): BulkResult => {
  const { db } = store;
  const result: BulkResult = { inserted: 0, skipped: 0, rejected: [] };

  db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = insertStmt(db);
    for (const doc of docs) {
      const data = extractData(doc);
      const _deleted = doc._deleted ?? false;
      const computed = revisionHash({
        _id: doc._id,
        _gen: doc._gen,
        _parent: doc._parent,
        _type: doc._type,
        _deleted,
        data,
      });
      if (computed !== doc._hash) {
        result.rejected.push({
          hash: doc._hash,
          reason: new IntegrityError(doc._hash, computed).message,
        });
        continue;
      }
      const info = stmt.run(
        doc._hash,
        doc._id,
        doc._gen,
        doc._parent ?? null,
        doc._type ?? null,
        JSON.stringify(data),
        _deleted ? 1 : 0,
        doc._createdAt,
      );
      if (info.changes === 1) result.inserted++;
      else result.skipped++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return result;
};

/** All revisions with `_seq > since`, in `_seq` order. Drives replication. */
export const changesSince = (store: Store, since: number): Document[] => {
  const rows = changesStmt(store.db).all(since) as Row[];
  return rows.map(rowToDocument);
};
