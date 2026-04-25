/**
 * Thrown by `put` when `_parent` is not a current leaf for `_id` — either
 * the caller supplied a stale revision, or omitted `_parent` for a
 * document that already has revisions. `actualLeaves` carries the current
 * leaf `_rev`s so callers can re-read and retry against a real leaf.
 */
export class ConflictError extends Error {
  override name = "ConflictError";
  readonly id: string;
  readonly expectedParent: string | undefined;
  readonly actualLeaves: string[];

  constructor(
    id: string,
    expectedParent: string | undefined,
    actualLeaves: string[],
  ) {
    super(
      `conflict on _id ${JSON.stringify(id)}: expected parent ${
        expectedParent === undefined
          ? "<genesis>"
          : JSON.stringify(expectedParent)
      }, current leaves [${actualLeaves.map((h) => JSON.stringify(h)).join(", ")}]`,
    );
    this.id = id;
    this.expectedParent = expectedParent;
    this.actualLeaves = actualLeaves;
  }
}

/**
 * Recorded by `bulkInsert` (in `result.rejected`) when a row's `_rev` hash
 * does not match the hash recomputed from the supplied fields — indicating
 * the row was tampered with, or the sender produced it from a different
 * definition of the hash input. Constructed for its message; never thrown
 * by the library itself.
 */
export class IntegrityError extends Error {
  override name = "IntegrityError";
  readonly providedHash: string;
  readonly computedHash: string;

  constructor(providedHash: string, computedHash: string) {
    super(
      `hash mismatch: provided ${JSON.stringify(providedHash)}, computed ${JSON.stringify(computedHash)}`,
    );
    this.providedHash = providedHash;
    this.computedHash = computedHash;
  }
}
