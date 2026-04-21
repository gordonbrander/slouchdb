import { test } from "node:test";
import { deepStrictEqual, notDeepStrictEqual, ok } from "node:assert/strict";
import { cid, deterministic, toDeterministicBytes } from "./cid.ts";

test("deterministic - returns a new object with sorted keys", () => {
  const input = { b: 1, a: 2, c: 3 };
  const result = deterministic(input) as Record<string, unknown>;
  deepStrictEqual(Object.keys(result), ["a", "b", "c"]);
});

test("deterministic - does not mutate input", () => {
  const input = { b: 1, a: 2, c: 3 };
  const originalKeys = Object.keys(input);
  deterministic(input);
  deepStrictEqual(Object.keys(input), originalKeys);
});

test("deterministic - recursively sorts nested object keys", () => {
  const input = { b: { z: 1, y: 2 }, a: { d: 3, c: 4 } };
  const result = deterministic(input) as Record<
    string,
    Record<string, unknown>
  >;
  deepStrictEqual(Object.keys(result), ["a", "b"]);
  deepStrictEqual(Object.keys(result.a), ["c", "d"]);
  deepStrictEqual(Object.keys(result.b), ["y", "z"]);
});

test("deterministic - recurses into arrays without reordering", () => {
  const input = {
    list: [
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ],
  };
  const result = deterministic(input) as {
    list: Array<Record<string, unknown>>;
  };
  deepStrictEqual(Object.keys(result.list[0]), ["a", "b"]);
  deepStrictEqual(Object.keys(result.list[1]), ["c", "d"]);
  deepStrictEqual(result.list.length, 2);
});

test("deterministic - returns primitives unchanged", () => {
  deepStrictEqual(deterministic(42), 42);
  deepStrictEqual(deterministic("hello"), "hello");
  deepStrictEqual(deterministic(true), true);
  deepStrictEqual(deterministic(null), null);
  deepStrictEqual(deterministic(undefined), undefined);
});

test("toDeterministicBytes - produces identical bytes for reordered keys", () => {
  const a = toDeterministicBytes({ a: 1, b: 2, c: 3 });
  const b = toDeterministicBytes({ c: 3, b: 2, a: 1 });
  deepStrictEqual(a, b);
});

test("toDeterministicBytes - produces identical bytes for nested reordering", () => {
  const a = toDeterministicBytes({ outer: { x: 1, y: 2 }, list: [1, 2, 3] });
  const b = toDeterministicBytes({ list: [1, 2, 3], outer: { y: 2, x: 1 } });
  deepStrictEqual(a, b);
});

test("toDeterministicBytes - returns UTF-8 encoded JSON with sorted keys", () => {
  const bytes = toDeterministicBytes({ b: 2, a: 1 });
  deepStrictEqual(new TextDecoder().decode(bytes), '{"a":1,"b":2}');
});

test("toDeterministicBytes - preserves array order", () => {
  const a = toDeterministicBytes([1, 2, 3]);
  const b = toDeterministicBytes([3, 2, 1]);
  notDeepStrictEqual(a, b);
});

test("cid - returns a lowercase hex SHA-256 digest", () => {
  const hash = cid({ a: 1 });
  deepStrictEqual(hash.length, 64);
  ok(/^[0-9a-f]{64}$/.test(hash), `expected hex digest, got ${hash}`);
});

test("cid - is deterministic for the same logical value", () => {
  deepStrictEqual(cid({ a: 1, b: 2 }), cid({ b: 2, a: 1 }));
  deepStrictEqual(
    cid({ nested: { x: 1, y: 2 }, arr: [1, 2] }),
    cid({ arr: [1, 2], nested: { y: 2, x: 1 } }),
  );
});

test("cid - differs for different values", () => {
  notDeepStrictEqual(cid({ a: 1 }), cid({ a: 2 }));
  notDeepStrictEqual(cid({ a: 1 }), cid({ b: 1 }));
  notDeepStrictEqual(cid([1, 2, 3]), cid([3, 2, 1]));
});

test("cid - handles primitives", () => {
  deepStrictEqual(cid(42), cid(42));
  deepStrictEqual(cid("hello"), cid("hello"));
  deepStrictEqual(cid(true), cid(true));
  notDeepStrictEqual(cid(42), cid("42"));
});

test("cid - handles empty structures", () => {
  deepStrictEqual(cid({}), cid({}));
  deepStrictEqual(cid([]), cid([]));
  notDeepStrictEqual(cid({}), cid([]));
});
