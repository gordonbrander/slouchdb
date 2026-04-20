# Project

## Philosophy

Write pragmatic functional TypeScript. Prefer pure functions and data over classes (unless an API requires a class). Minimize side effects — functional core, imperative shell. Favor simplicity and immutability.

## Tech stack

- Runtime: Node.js 25+ (runs `.ts` files directly via native type stripping)
- Frontend: Lit
- Server: Hono (with `@hono/node-server` adapter)
- Storage: `node:sqlite` (built-in)
- Design system: [DUI](https://github.com/deepfuturenow/dui) (npm packages `@deepfuture/dui-*`)
- Build system: ESBuild (bundler scripts in `scripts/`)
- Testing: Node's built-in test runner (`node --test`). Assertions via `node:assert` (wrapped by `util/test-helpers.ts`).

## Project structure

- `server.ts` — Hono server entry
- `client/` — SPA codebase
- `client/main.ts` — Client entry point
- `client/bootstrap.ts` — DUI component registration (`applyTheme`)
- `client/theme.ts` — Dark mode toggle
- `client/components/` — Lit web components
- `client/client-config.ts` — Build-time environment config
- `features/` — feature-oriented code. Each `features/<name>/` directory owns
  its data model, primitives, and public API. `features/<name>/index.ts` is the
  curated entry point (not a barrel) — it exports only what's part of the
  public surface. Supporting files live as siblings; consumers who need
  something `index.ts` intentionally doesn't expose import from the sibling
  directly. Current features: `features/notes/`, `features/busytown/`,
  `features/exa/`.
- `util/` — shared utilities (cid, schema-resolver, file-to-markdown, etc.)
- `esbuild/` — custom esbuild plugins
- `scripts/` — build/dev scripts (`dev.ts`, `bundle.ts`, `watch-bundle.ts`) and Node CLIs (`ingest-raw`, `notes-insert`, `notes-query`, `file-to-markdown`) exposed as npm run scripts — invoke as `npm run <name> -- --flag value`
- `docs/` — project documentation
- `.pi/` — Busytown agents and event queue runtime state. Pi extensions live
  at `.pi/extensions/<name>.ts`; each extension wires pi tool
  definitions to feature APIs. Extensions may import from `features/*`;
  features must not import from extensions.

## Running commands

- Run npm scripts from the project root: `npm run check`, `npm test`, `npm run dev`, `npm run bundle`
- Run ad-hoc TS files with: `node path/to/file.ts` (Node 25 strips types by default)
- Always use `git -C /absolute/path <subcommand>` instead of `cd /path && git <subcommand>`. This avoids permissions prompts.

## TypeScript style

- Arrow functions with explicit return types
- File extensions in all import paths (`.ts`)
- `type` over `interface`; `undefined` over `null`
- Namespace imports uppercase: `import * as Schema from "./schema.ts"`
- Use `type` keyword on type imports: `import { type User } from "./types.ts"`
- Export at point of definition, not at end of file
- Private fields: native `#field`, not TypeScript `private`

Full guide: `docs/typescript-style.md`

## Client architecture

Components follow "data down, events up". Most components are vanilla Lit (receive props, emit CustomEvents). Only 1-2 levels of connected components own Refrakt stores. See `docs/client-architecture.md`.

## Testing

- Use Node's built-in test runner (`node --test`)
- Put tests next to source code (e.g. `foo.test.ts` next to `foo.ts`), not in a separate test directory
- Tests should be named `foo.test.ts`, not `foo_test.ts`
- Import the Deno-compatible assertion shims from `util/test-helpers.ts` (`assertEquals`, `assertExists`, `assertThrows`, etc.) — these wrap `node:assert`.

## DUI

DUI is installed via npm packages (`@deepfuture/dui-core`, `@deepfuture/dui-components`, `@deepfuture/dui-theme-default`). Import them by their full npm names. Components are registered in `client/bootstrap.ts` via `applyTheme()`.

### Dark mode

This project uses `data-theme="dark"` on `<html>` (see `client/theme.ts`). The DUI theme tokens respond automatically — no per-component dark mode logic needed.

### Inspector

The DUI Inspector is loaded in development mode only (`client/main.ts`). Toggle with **Ctrl+Shift+I** to visually inspect and edit DUI components at runtime.

## Debugging DUI components

When debugging DUI component behavior (events not firing, props not updating, context not propagating), use the DUI Inspector in the browser **before** reading `node_modules` source. Run `__dui_inspect('dui-toggle-group')` in the browser console (or via `chrome_devtools_evaluate_script`) to see properties, slots, events, and context state at a glance. See the DUI skill for the full inspector API.

## Do NOT

- Do not use React patterns, JSX, or React component conventions. This is a Lit project.
- Do not add a TypeScript transpile step; rely on Node 25's native type stripping (`tsc` is for type-checking only, `--noEmit`).
- Do not use `querySelector` to reach into another component's Shadow DOM from outside.
- Do not hardcode colors. Use DUI semantic tokens (`--foreground`, `--muted-foreground`, `--primary`, etc.).
- Do not use `!important` to override DUI styles. Use CSS custom properties or `::part(root)`.

## References

- TypeScript style guide: `docs/typescript-style.md`
- Architecture (data model, agent graph, tool surface, schemas): `docs/architecture.md`
- Client architecture (stores, signals, components): `docs/client-architecture.md`
- Stateless Lit component principles: `docs/reference/lit-stateless-components.md`
- DUI consuming guide: [consuming.md](https://github.com/deepfuturenow/dui/blob/main/docs/consuming.md)
- DUI component catalog & styling: covered by the DUI agent skill (install via `npx skills add deepfuturenow/dui --skill dui`)
