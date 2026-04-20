import {
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  ok,
  rejects,
  throws,
} from "node:assert/strict";

export const assertEquals = <T>(actual: T, expected: T, msg?: string): void =>
  deepStrictEqual(actual, expected, msg);

export const assertNotEquals = <T>(
  actual: T,
  expected: T,
  msg?: string,
): void => notDeepStrictEqual(actual, expected, msg);

export const assertStrictEquals = <T>(
  actual: T,
  expected: T,
  msg?: string,
): void => strictEqual(actual, expected, msg);

export const assert = (condition: unknown, msg?: string): void =>
  ok(condition, msg);

export const assertExists = <T>(
  value: T,
  msg?: string,
): asserts value is NonNullable<T> => {
  if (value === null || value === undefined) {
    throw new Error(msg ?? "expected value to exist");
  }
};

const matches = (
  ErrorClass?: new (...args: unknown[]) => Error,
  msg?: string | RegExp,
) =>
  (err: unknown): true => {
    if (ErrorClass && !(err instanceof ErrorClass)) {
      throw new Error(
        `expected error to be instance of ${ErrorClass.name}, got ${(err as { constructor?: { name?: string } })?.constructor?.name ?? typeof err}`,
      );
    }
    if (msg !== undefined) {
      const m = (err as Error)?.message ?? "";
      const ok =
        typeof msg === "string" ? m.includes(msg) : (msg as RegExp).test(m);
      if (!ok) {
        throw new Error(
          `expected error message to match ${msg}, got ${JSON.stringify(m)}`,
        );
      }
    }
    return true;
  };

export const assertRejects = async (
  promiseOrFn: Promise<unknown> | (() => Promise<unknown>),
  ErrorClass?: new (...args: unknown[]) => Error,
  msgIncludes?: string | RegExp,
): Promise<void> => {
  const fn =
    typeof promiseOrFn === "function" ? promiseOrFn : () => promiseOrFn;
  await rejects(fn, matches(ErrorClass, msgIncludes));
};

export const assertThrows = (
  fn: () => unknown,
  ErrorClass?: new (...args: unknown[]) => Error,
  msgIncludes?: string | RegExp,
): void => {
  throws(fn, matches(ErrorClass, msgIncludes));
};
