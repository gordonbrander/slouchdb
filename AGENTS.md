## Coding Philosophy

Write pragmatic functional TypeScript. Prefer pure functions and data over classes (unless an API requires a class). Minimize side effects — functional core, imperative shell. Favor simplicity and immutability.

## TypeScript style

- Arrow functions with explicit return types
- File extensions in all import paths (`.ts`)
- `type` over `interface`; `undefined` over `null`
- Namespace imports uppercase: `import * as Schema from "./schema.ts"`
- Use `type` keyword on type imports: `import { type User } from "./types.ts"`
- Export at point of definition, not at end of file
- Private fields: native `#field`, not TypeScript `private`
- Factory function naming convention: `fooOf()`, `barOf()`, `bazOf()`

## Client architecture

Components follow "data down, events up". Most components are vanilla Lit (receive props, emit CustomEvents). Only 1-2 levels of connected components own Refrakt stores. See `docs/client-architecture.md`.

## Testing

- Use Node's built-in test runner (`node --test`)
- Put tests next to source code (e.g. `foo.test.ts` next to `foo.ts`), not in a separate test directory
- Tests should be named `foo.test.ts`, not `foo_test.ts`
- Import assertions directly from `node:assert/strict` (`deepStrictEqual`, `ok`, `throws`, `rejects`, etc.).
