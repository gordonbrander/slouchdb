import { test } from "node:test";
import { assert, assertThrows } from "./test-helpers.ts";
import { openStore, parseRev, put, type PendingDocument } from "./store.ts";
import { clearSchemaCache, validate } from "./validate.ts";
import { ValidationError } from "./errors.ts";

/** Shape a PendingDocument without going through put (for direct validate calls). */
const pending = (fields: Partial<PendingDocument> & { _id: string }): PendingDocument => ({
  _rev: "1-test",
  _parent: undefined,
  _type: undefined,
  _deleted: false,
  ...fields,
});

test("validate - unknown type is a silent no-op", () => {
  clearSchemaCache();
  const store = openStore(":memory:", { validate });
  validate(store, "widget", pending({ _id: "w1", anything: "goes" }));
});

test("validate - tombstoned schema is treated as absent", () => {
  clearSchemaCache();
  const store = openStore(":memory:", { validate });
  const s = put(store, {
    _id: "_schema/thing",
    _type: "_schema",
    type: "object",
    required: ["x"],
    properties: { x: { type: "string" } },
  });
  assertThrows(
    () => validate(store, "thing", pending({ _id: "t1" })),
    ValidationError,
  );
  put(store, {
    _id: "_schema/thing",
    _type: "_schema",
    _parent: s._rev,
    _deleted: true,
  });
  validate(store, "thing", pending({ _id: "t1" }));
});

test("validate - caches compiled zod by schema-doc _rev; invalidates on update", () => {
  clearSchemaCache();
  const store = openStore(":memory:", { validate });
  const s1 = put(store, {
    _id: "_schema/coin",
    _type: "_schema",
    type: "object",
    required: ["side"],
    properties: { side: { type: "string" } },
  });
  validate(store, "coin", pending({ _id: "c1", side: "heads" }));
  validate(store, "coin", pending({ _id: "c2", side: "tails" }));

  const s2 = put(store, {
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
  assert(parseRev(s2._rev).gen === 2);
  assertThrows(
    () => validate(store, "coin", pending({ _id: "c3", side: "heads" })),
    ValidationError,
  );
});
