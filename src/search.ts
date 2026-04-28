import { type Document, type Store } from "./store.ts";

/** Options for {@link search}. */
export type SearchOptions = {
  /**
   * FTS5 MATCH expression. Pass-through: supports `AND` / `OR` / `NOT`,
   * `"phrases"`, and `prefix*` operators. Empty or whitespace-only queries
   * short-circuit to an empty result.
   */
  query: string;
  /** Max rows. Default 25, clamped to [1, 1000]. */
  limit?: number;
};

/** A single search result: the winning document plus its FTS5 bm25 score. */
export type SearchHit = {
  document: Document;
  /** FTS5 `bm25()` score; lower = better match. */
  score: number;
};

type Row = {
  _local_seq: number;
  _rev: string;
  _id: string;
  _parent: string | null;
  _type: string | null;
  _deleted: number;
  data: string;
  score: number;
};

const rowToHit = (row: Row): SearchHit => ({
  document: {
    _local_seq: row._local_seq,
    _rev: row._rev,
    _id: row._id,
    _parent: row._parent ?? undefined,
    _type: row._type ?? undefined,
    _deleted: row._deleted === 1,
    ...(JSON.parse(row.data) as Record<string, unknown>),
  },
  score: row.score,
});

const searchStmt = (store: Store) =>
  store.prepare(`
    SELECT d.*, f.rank AS score
    FROM documents_fts f
    JOIN documents d ON d._local_seq = f.rowid
    WHERE documents_fts MATCH ?
    ORDER BY f.rank
    LIMIT ?
  `);

/**
 * Full-text search across document winners. Returns hits ordered by FTS5
 * `bm25()` rank (lower is better). Only the current winning leaf of each
 * `_id` is searchable; tombstones, internal revisions, and losing conflict
 * leaves are excluded by the index itself (maintained via trigger).
 */
export const search = (store: Store, options: SearchOptions): SearchHit[] => {
  const query = options.query.trim();
  if (query === "") return [];
  const limit = Math.max(1, Math.min(1000, options.limit ?? 25));
  const rows = searchStmt(store).all(query, limit) as Row[];
  return rows.map(rowToHit);
};
