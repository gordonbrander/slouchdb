import { DatabaseSync } from "node:sqlite";

/** SQL statements applied in order. Index i corresponds to migration version i+1. */
export type Migration = string;

/**
 * Open a SQLite database at `path` (":memory:" for an in-memory DB) and apply
 * any migrations that have not yet run. Migrations are identified by their
 * 1-based index; applied versions are tracked in `_migrations`.
 */
export const openDatabase = (
  path: string,
  migrations: readonly Migration[],
): DatabaseSync => {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set<number>(
    (
      db
        .prepare("SELECT version FROM _migrations")
        .all() as Array<{ version: number }>
    ).map((r) => r.version),
  );

  const insertVersion = db.prepare(
    "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
  );

  for (let i = 0; i < migrations.length; i++) {
    const version = i + 1;
    if (applied.has(version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[i]);
      insertVersion.run(version, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return db;
};
