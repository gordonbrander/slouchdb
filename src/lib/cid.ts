import { createHash } from "node:crypto";

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

/** Returns the lowercase hex-encoded SHA-256 digest of `value`. */
export const cid = (value: unknown): string => {
  const bytes = toDeterministicBytes(value);
  return createHash("sha256").update(bytes).digest("hex");
};
