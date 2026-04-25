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
