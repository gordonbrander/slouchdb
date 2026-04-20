import { createHash } from "node:crypto";
import { encodeBase32LowerNoPadding } from "./base32.ts";

/** Return a structural copy of `value` with object keys recursively sorted. */
export const deterministic = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(deterministic);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = deterministic((value as Record<string, unknown>)[key]);
  }
  return sorted;
};

const textEncoder = new TextEncoder();

/** Convert a value to deterministic bytes for hash generation. */
export const toDeterministicBytes = (value: unknown): Uint8Array => {
  const sorted = deterministic(value);
  return textEncoder.encode(JSON.stringify(sorted));
};

/**
 * Returns the lowercased unpadded base32-encoded SHA-256 digest of `value`.
 */
export const cid = (value: unknown): string => {
  const bytes = toDeterministicBytes(value);
  const digest = new Uint8Array(createHash("sha256").update(bytes).digest());
  return encodeBase32LowerNoPadding(digest);
};
