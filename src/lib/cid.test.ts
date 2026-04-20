import { test } from "node:test";
import { assert, assertEquals, assertNotEquals } from "./test-helpers.ts";
import { cid, deterministic, toDeterministicBytes } from "./cid.ts";

test("deterministic - returns a new object with sorted keys", () => {
  const input = { b: 1, a: 2, c: 3 };
  const result = deterministic(input) as Record<string, unknown>;
  assertEquals(Object.keys(result), ["a", "b", "c"]);
});

test("deterministic - does not mutate input", () => {
  const input = { b: 1, a: 2, c: 3 };
  const originalKeys = Object.keys(input);
  deterministic(input);
  assertEquals(Object.keys(input), originalKeys);
});

test("deterministic - recursively sorts nested object keys", () => {
  const input = { b: { z: 1, y: 2 }, a: { d: 3, c: 4 } };
  const result = deterministic(input) as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(Object.keys(result), ["a", "b"]);
  assertEquals(Object.keys(result.a), ["c", "d"]);
  assertEquals(Object.keys(result.b), ["y", "z"]);
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
  assertEquals(Object.keys(result.list[0]), ["a", "b"]);
  assertEquals(Object.keys(result.list[1]), ["c", "d"]);
  assertEquals(result.list.length, 2);
});

test("deterministic - returns primitives unchanged", () => {
  assertEquals(deterministic(42), 42);
  assertEquals(deterministic("hello"), "hello");
  assertEquals(deterministic(true), true);
  assertEquals(deterministic(null), null);
  assertEquals(deterministic(undefined), undefined);
});

test("toDeterministicBytes - produces identical bytes for reordered keys", () => {
  const a = toDeterministicBytes({ a: 1, b: 2, c: 3 });
  const b = toDeterministicBytes({ c: 3, b: 2, a: 1 });
  assertEquals(a, b);
});

test("toDeterministicBytes - produces identical bytes for nested reordering", () => {
  const a = toDeterministicBytes({ outer: { x: 1, y: 2 }, list: [1, 2, 3] });
  const b = toDeterministicBytes({ list: [1, 2, 3], outer: { y: 2, x: 1 } });
  assertEquals(a, b);
});

test("toDeterministicBytes - returns UTF-8 encoded JSON with sorted keys", () => {
  const bytes = toDeterministicBytes({ b: 2, a: 1 });
  assertEquals(new TextDecoder().decode(bytes), '{"a":1,"b":2}');
});

test("toDeterministicBytes - preserves array order", () => {
  const a = toDeterministicBytes([1, 2, 3]);
  const b = toDeterministicBytes([3, 2, 1]);
  assertNotEquals(a, b);
});

test("cid - returns an unpadded lowercase base32 SHA-256 digest", () => {
  const hash = cid({ a: 1 });
  assertEquals(hash.length, 52);
  assert(/^[a-z2-7]{52}$/.test(hash), `expected base32 digest, got ${hash}`);
});

test("cid - is deterministic for the same logical value", () => {
  assertEquals(cid({ a: 1, b: 2 }), cid({ b: 2, a: 1 }));
  assertEquals(
    cid({ nested: { x: 1, y: 2 }, arr: [1, 2] }),
    cid({ arr: [1, 2], nested: { y: 2, x: 1 } }),
  );
});

test("cid - differs for different values", () => {
  assertNotEquals(cid({ a: 1 }), cid({ a: 2 }));
  assertNotEquals(cid({ a: 1 }), cid({ b: 1 }));
  assertNotEquals(cid([1, 2, 3]), cid([3, 2, 1]));
});

test("cid - handles primitives", () => {
  assertEquals(cid(42), cid(42));
  assertEquals(cid("hello"), cid("hello"));
  assertEquals(cid(true), cid(true));
  assertNotEquals(cid(42), cid("42"));
});

test("cid - handles empty structures", () => {
  assertEquals(cid({}), cid({}));
  assertEquals(cid([]), cid([]));
  assertNotEquals(cid({}), cid([]));
});
