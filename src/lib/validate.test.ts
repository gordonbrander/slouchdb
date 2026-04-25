import { test } from "node:test";
import { deepStrictEqual, ok } from "node:assert/strict";
import {
  bulkInsert,
  changesSince,
  openStore,
  put,
  type BulkDocument,
} from "./store.ts";
import { clearSchemaCache, getSchema } from "./validate.ts";

test("getSchema - unknown type returns undefined", () => {
  clearSchemaCache();
  const store = openStore(":memory:");
  deepStrictEqual(getSchema(store, "widget"), undefined);
});

test("getSchema - tombstoned schema returns undefined", () => {
  clearSchemaCache();
  const store = openStore(":memory:");
  const s = put(store, {
    _id: "_schema/thing",
    _type: "_schema",
    type: "object",
    required: ["x"],
    properties: { x: { type: "string" } },
  });
  ok(getSchema(store, "thing"));
  put(store, {
    _id: "_schema/thing",
    _type: "_schema",
    _parent: s._rev,
    _deleted: true,
  });
  deepStrictEqual(getSchema(store, "thing"), undefined);
});

test("getSchema - returned schema validates user data via safeParse", () => {
  clearSchemaCache();
  const store = openStore(":memory:");
  put(store, {
    _id: "_schema/note",
    _type: "_schema",
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  });
  const schema = getSchema(store, "note");
  ok(schema);
  deepStrictEqual(schema.safeParse({ title: "hi" }).success, true);
  deepStrictEqual(schema.safeParse({}).success, false);
  deepStrictEqual(schema.safeParse({ title: "hi", extra: 1 }).success, false);
});

test("getSchema - caches by schema-doc _rev; recompiles when the schema is updated", () => {
  clearSchemaCache();
  const store = openStore(":memory:");
  const s1 = put(store, {
    _id: "_schema/coin",
    _type: "_schema",
    type: "object",
    required: ["side"],
    properties: { side: { type: "string" } },
  });
  const a = getSchema(store, "coin");
  const b = getSchema(store, "coin");
  ok(a === b);

  put(store, {
    _id: "_schema/coin",
    _type: "_schema",
    _parent: s1._rev,
    type: "object",
    required: ["side", "flips"],
    properties: {
      side: { type: "string" },
      flips: { type: "number" },
    },
  });
  const c = getSchema(store, "coin");
  ok(c !== a);
  deepStrictEqual(c?.safeParse({ side: "heads" }).success, false);
  deepStrictEqual(c?.safeParse({ side: "heads", flips: 3 }).success, true);
});

test("getSchema - schemas propagate via replication; downstream getSchema sees them", () => {
  clearSchemaCache();
  const sourceA = openStore(":memory:");
  put(sourceA, {
    _id: "_schema/post",
    _type: "_schema",
    type: "object",
    properties: { body: { type: "string" } },
    required: ["body"],
  });

  const sourceB = openStore(":memory:");
  const changes = changesSince(sourceA, 0);
  const result = bulkInsert(sourceB, changes as unknown as BulkDocument[]);
  deepStrictEqual(result.inserted, 1);

  const schema = getSchema(sourceB, "post");
  ok(schema);
  deepStrictEqual(schema.safeParse({}).success, false);
  deepStrictEqual(schema.safeParse({ body: "hello" }).success, true);
});
