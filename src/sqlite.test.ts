import { test } from "node:test";
import { deepStrictEqual, throws } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, savepoint } from "./sqlite.ts";

const freshDb = (): DatabaseSync => {
  const db = openDatabase(":memory:", [
    "CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)",
  ]);
  return db;
};

const allRows = (db: DatabaseSync): Array<{ k: string; v: string }> =>
  (
    db.prepare("SELECT k, v FROM t ORDER BY k").all() as Array<{
      k: string;
      v: string;
    }>
  ).map((r) => ({ k: r.k, v: r.v }));

test("savepoint - success commits writes and forwards return value", () => {
  const db = freshDb();
  const out = savepoint(db, "sp", () => {
    db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("a", "1");
    return 42;
  });
  deepStrictEqual(out, 42);
  deepStrictEqual(allRows(db), [{ k: "a", v: "1" }]);
});

test("savepoint - throw rolls back and rethrows", () => {
  const db = freshDb();
  throws(
    () =>
      savepoint(db, "sp", () => {
        db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("a", "1");
        throw new Error("boom");
      }),
    /boom/,
  );
  deepStrictEqual(allRows(db), []);
});

test("savepoint - nested success: outer release commits both layers", () => {
  const db = freshDb();
  savepoint(db, "outer", () => {
    db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("a", "outer");
    savepoint(db, "inner", () => {
      db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("b", "inner");
    });
  });
  deepStrictEqual(allRows(db), [
    { k: "a", v: "outer" },
    { k: "b", v: "inner" },
  ]);
});

test("savepoint - nested inner-throw caught by outer: outer write persists", () => {
  const db = freshDb();
  savepoint(db, "outer", () => {
    db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("a", "outer");
    try {
      savepoint(db, "inner", () => {
        db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("b", "inner");
        throw new Error("inner-boom");
      });
    } catch {
      // swallow at outer scope
    }
  });
  deepStrictEqual(allRows(db), [{ k: "a", v: "outer" }]);
});

test("savepoint - nested inner-success, outer-throw: both rolled back", () => {
  const db = freshDb();
  throws(
    () =>
      savepoint(db, "outer", () => {
        savepoint(db, "inner", () => {
          db.prepare("INSERT INTO t (k, v) VALUES (?, ?)").run("a", "inner");
        });
        throw new Error("outer-boom");
      }),
    /outer-boom/,
  );
  deepStrictEqual(allRows(db), []);
});
