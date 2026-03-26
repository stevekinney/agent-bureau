---
description: TypeScript patterns and conventions enforced across all packages
globs: "**/*.ts"
---

# TypeScript Conventions

## File Format

- All source and test files are `.ts` — never `.mjs` or `.js`.
- Published packages emit both ESM and CJS via the build script.

## API Design

- **Factory functions over classes**: `createStore()`, `createMemory()`, `createRun()`, `createAnthropicGenerate()`.
- **Immutability via spread**: never mutate objects directly; create new copies with spread operators.
- **Environment-first configuration**: environment variables validated through Zod schemas (typically in `src/environment.ts`). The `environment` object is the single source of truth.
- **Zod for runtime validation**: use Zod schemas at system boundaries for input validation.

## Strict TypeScript

These compiler options are enabled across all packages:

- `noUncheckedIndexedAccess` — indexed access returns `T | undefined`
- `noImplicitReturns` — all code paths must return
- `noPropertyAccessFromIndexSignature` — use bracket notation for index signatures

## Imports

Order enforced by `simple-import-sort`:

1. Bun builtins (e.g., `import { file } from 'bun'`)
2. Node builtins with `node:` prefix (e.g., `import { join } from 'node:path'`)
3. External packages (e.g., `import { z } from 'zod'`)
4. Internal absolute imports
5. Relative imports

## Bun Preferences

| Task          | Use (Bun)                                 | Avoid (Node)                      |
| ------------- | ----------------------------------------- | --------------------------------- |
| Read file     | `Bun.file(path).text()`                   | `fs.readFileSync(path, 'utf-8')`  |
| Write file    | `Bun.write(path, data)`                   | `fs.writeFileSync(path, data)`    |
| HTTP server   | `Bun.serve()`                             | `http.createServer()` or Express  |
| Hashing       | `Bun.hash()` or `new Bun.CryptoHasher()` | `crypto.createHash()`             |
| Spawn process | `Bun.spawn()` or `Bun.$`                  | `child_process.spawn()`           |
| Environment   | `Bun.env.VAR`                             | `process.env.VAR`                 |

When Bun has no equivalent, use the `node:` prefix for clarity.

## Module Organization

- Type re-exports go in `types.ts`, not barrel `index.ts` files.
- Packages expose subpath exports for tree-shaking (e.g., `"./test"`, `"./anthropic"`).
- Extend existing files rather than creating new ones when adding to a package.
