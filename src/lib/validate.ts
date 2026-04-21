import * as z from "zod/v4";
import { ValidationError } from "./errors.ts";
import { extractData, get, type PendingDocument, type Store } from "./store.ts";

const compiledCache: Map<string, z.ZodType> = new Map();

/** Clear the compiled-schema cache. Test-only; normal callers need not call. */
export const clearSchemaCache = (): void => {
  compiledCache.clear();
};

const compile = (jsonSchema: unknown): z.ZodType =>
  z.fromJSONSchema(
    jsonSchema as Parameters<typeof z.fromJSONSchema>[0],
  ) as z.ZodType;

/**
 * Validator wired for {@link openStore}. Looks up the winning revision of
 * `_schema/<type>`; if it exists and is not a tombstone, compiles its user-
 * data portion as a JSONSchema and runs `safeParse` against `doc`'s user
 * data. The compiled schema is cached by the schema document's `_rev`
 * (content-addressed; invalidates automatically when the schema changes).
 *
 * If no schema document exists, validation is skipped. Rationale: a freshly
 * replicated database may receive typed documents before their schema has
 * replicated in. Enforcing a missing schema would stall replication. The
 * contract is: validation is enforced when a schema is known.
 */
export const validate = (
  store: Store,
  type: string,
  doc: PendingDocument,
): void => {
  const schemaDoc = get(store, `_schema/${type}`);
  if (!schemaDoc || schemaDoc._deleted) return;

  let compiled = compiledCache.get(schemaDoc._rev);
  if (!compiled) {
    compiled = compile(extractData(schemaDoc));
    compiledCache.set(schemaDoc._rev, compiled);
  }

  const data = extractData(doc);
  const result = compiled.safeParse(data);
  if (!result.success) {
    throw new ValidationError(type, result.error.issues);
  }
};
