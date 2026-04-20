import { test } from "node:test";
import { assertEquals } from "./test-helpers.ts";
import { decodeBase32NoPadding, encodeBase32LowerNoPadding } from "./base32.ts";

test("encodeBase32LowerNoPadding - encodes to lowercase without padding", () => {
  const input = new TextEncoder().encode("Hello");
  const encoded = encodeBase32LowerNoPadding(input);

  // Should be lowercase
  assertEquals(encoded, encoded.toLowerCase());
  // Should not contain padding
  assertEquals(encoded.includes("="), false);
  // Known value: "Hello" -> "JBSWY3DP" (uppercase, no padding needed)
  assertEquals(encoded, "jbswy3dp");
});

test("encodeBase32LowerNoPadding - strips padding when needed", () => {
  // "Hi" encodes to "JBUQ====" (padded to 8 chars), we strip padding
  const input = new TextEncoder().encode("Hi");
  const encoded = encodeBase32LowerNoPadding(input);

  assertEquals(encoded, "jbuq");
  assertEquals(encoded.includes("="), false);
});

test("decodeBase32NoPadding - decodes unpadded string", () => {
  const encoded = "jbswy3dp"; // "Hello" without padding
  const decoded = decodeBase32NoPadding(encoded);
  const text = new TextDecoder().decode(decoded);

  assertEquals(text, "Hello");
});

test("decodeBase32NoPadding - handles string that needed padding", () => {
  const encoded = "jbuq"; // "Hi" without padding (originally "JBUQ====")
  const decoded = decodeBase32NoPadding(encoded);
  const text = new TextDecoder().decode(decoded);

  assertEquals(text, "Hi");
});

test("round-trip encode/decode preserves data", () => {
  const testCases = [
    new Uint8Array([]), // empty
    new Uint8Array([0]), // single byte
    new Uint8Array([1, 2, 3, 4, 5]), // 5 bytes (no padding needed)
    new Uint8Array([1, 2, 3]), // 3 bytes (padding needed)
    new Uint8Array(32).fill(0xff), // 32 bytes (like SHA-256 output)
  ];

  for (const original of testCases) {
    const encoded = encodeBase32LowerNoPadding(original);
    const decoded = decodeBase32NoPadding(encoded);
    assertEquals(
      decoded,
      original,
      `Failed for input of length ${original.length}`,
    );
  }
});

test("encodeBase32LowerNoPadding - SHA-256 sized input produces 52 chars", () => {
  // SHA-256 produces 32 bytes = 256 bits
  // Base32 encodes 5 bits per character
  // 256 / 5 = 51.2, rounds up to 52 characters (plus padding to 56, which we strip)
  const sha256Sized = new Uint8Array(32).fill(0xab);
  const encoded = encodeBase32LowerNoPadding(sha256Sized);

  assertEquals(encoded.length, 52);
});

test("decodeBase32NoPadding - handles uppercase input", () => {
  // Should handle uppercase even though we produce lowercase
  const encoded = "JBSWY3DP";
  const decoded = decodeBase32NoPadding(encoded);
  const text = new TextDecoder().decode(decoded);

  assertEquals(text, "Hello");
});
