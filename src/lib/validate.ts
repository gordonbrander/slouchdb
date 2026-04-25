import * as z from "zod/v4";
import { extractData, get, put, type Document, type Store } from "./store.ts";

const typeToSchemaId = (type: string): string => `_schema/${type}`;

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
 * Look up the registered schema for `type` and return it as a compiled Zod
 * schema. Reads the winning revision of `_schema/<type>`; returns undefined
 * if no such document exists or the schema has been tombstoned. Compiled
 * schemas are cached by the schema document's `_rev` (content-addressed,
 * so the cache invalidates automatically when the schema changes).
 *
 * Callers do whatever they want with the returned schema — typically
 * `safeParse` against the user-data portion of a document before writing.
 * Returning undefined for missing schemas means clients naturally tolerate
 * a freshly replicated database that holds typed documents whose schemas
 * have not yet replicated in.
 */
export const getSchema = (
  store: Store,
  type: string,
): z.ZodType | undefined => {
  const schemaDoc = get(store, typeToSchemaId(type));
  if (!schemaDoc || schemaDoc._deleted) return undefined;

  let compiled = compiledCache.get(schemaDoc._rev);
  if (!compiled) {
    compiled = compile(extractData(schemaDoc));
    compiledCache.set(schemaDoc._rev, compiled);
  }
  return compiled;
};

/**
 * Register or update the schema for `type`. Converts `zodSchema` to JSON
 * Schema and writes it as the `_schema/<type>` document. If a schema
 * document already exists for this type, the new revision extends it
 * linearly (parented on the current winning leaf, including a tombstone if
 * the schema was previously deleted). The written document round-trips
 * through {@link getSchema}.
 */
export const putSchema = (
  store: Store,
  type: string,
  zodSchema: z.ZodType,
  _parent?: string,
): Document => {
  const jsonSchema = z.toJSONSchema(zodSchema) as Record<string, unknown>;
  const schemaId = typeToSchemaId(type);
  const _resolvedParent = _parent ?? get(store, schemaId)?._rev;
  return put(store, {
    ...jsonSchema,
    _id: schemaId,
    _type: "_schema",
    _parent: _resolvedParent,
  });
};
