# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

This package lives in the `agent-bureau` monorepo under `packages/conversationalist/`. Tasks are orchestrated via Turborepo from the monorepo root.

## Essential Commands

### From the monorepo root (preferred)

```bash
turbo run build --filter=conversationalist        # Build this package
turbo run test --filter=conversationalist         # Run tests
turbo run lint --filter=conversationalist         # Lint
turbo run check-types --filter=conversationalist  # Type-check
```

### Within this package directory

```bash
bun run build             # Build for production (outputs to dist/)
bun test                  # Run all tests
bun test src/utilities    # Run tests in specific directory
bun test --watch          # Watch mode
bun test --coverage       # Generate coverage report
bun run lint              # Check linting errors
bun run lint:fix          # Auto-fix linting errors
bun run check-types       # TypeScript type checking
bun run format            # Format all files with Prettier
```

## Architecture Overview

### Core Design Principles

1. **Environment-First Configuration**: All configuration starts with environment variables validated through Zod schemas in `src/environment.ts`. The `environment` object is the single source of truth.

2. **Lean Surface Area**: Avoids framework-specific scaffolding. Add only what you need.

### Key Notes

- **ESM + TypeScript**: Source files are TypeScript modules; build output targets Node for npm compatibility.
- **Import paths**: Use standard TS/ESM imports; no special runtime helpers are required.
- **No git hooks**: Hooks are managed at the monorepo root level (not per-package).

### Workspace Relationship

`armorer` is listed as a `devDependency` with `"armorer": "workspace:*"`. It is not imported in this package's source or tests — the reference is a development-time declaration only.

## Development Patterns

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Tests import from `../src/` directly (Bun native TypeScript execution — no build step required).
- ESLint rules are relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`).
- A separate `tsconfig.test.json` is available with relaxed TypeScript settings for tests.

### Import Organization

Prettier plus import sorting keeps imports consistent. A common order is:

1. Bun built-ins (e.g., `import { file, write } from 'bun'`)
2. Node built-ins (e.g., `import { readFile } from 'node:fs'`)
3. External packages (e.g., `import { z } from 'zod'`)
4. Internal absolute imports (e.g., `@/configuration/environment`)
5. Relative imports (e.g., `./local-module`)

## Bun-Specific Considerations

- Always use `bun` commands, not `npm` or `yarn`.
- The lockfile in this repo is `bun.lock` (at the monorepo root).
- Bun provides native TypeScript execution without precompilation.
- Use `bunx` for one-off package execution (like `npx`).

### Prefer Bun Built-ins Over Node

When possible, use Bun's native APIs instead of Node.js equivalents. Bun's APIs are optimized for performance and often have a simpler interface.

| Task          | Use (Bun)                                | Avoid (Node)                     |
| ------------- | ---------------------------------------- | -------------------------------- |
| Read file     | `Bun.file(path).text()`                  | `fs.readFileSync(path, 'utf-8')` |
| Write file    | `Bun.write(path, data)`                  | `fs.writeFileSync(path, data)`   |
| HTTP server   | `Bun.serve()`                            | `http.createServer()` or Express |
| Hashing       | `Bun.hash()` or `new Bun.CryptoHasher()` | `crypto.createHash()`            |
| Spawn process | `Bun.spawn()` or `Bun.$`                 | `child_process.spawn()`          |
| Sleep         | `Bun.sleep(ms)`                          | `setTimeout` with promisify      |
| Environment   | `Bun.env.VAR`                            | `process.env.VAR`                |
| Glob          | `Bun.Glob`                               | `glob` package                   |

When a Bun equivalent doesn't exist or Node's API is more appropriate for the use case, use the `node:` prefix for clarity (e.g., `import { join } from 'node:path'`).

### Configuration Notes

- **bunfig.toml**: Build targets Bun with sourcemaps and minification.
- **TypeScript**: Uses Bun types; Node type libs are not included by default.
- **ESLint**: Flat config with `typescript-eslint` presets; type-aware rules only under `src/**` for speed.
- **Prettier**: Config is at the monorepo root (`.prettierrc.json`).
- **Testing**: You can run tests in parallel via `bun test --parallel`.
