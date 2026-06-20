---
description: Monorepo structure, Turborepo pipeline, and cross-package workflow
---

# Monorepo Workflow

## Turborepo Task Pipeline

All tasks except `format:check` depend on `^build` (build dependencies first):

- `build` — compile each package to `dist/` (ESM + CJS)
- `check-types` — TypeScript type checking (requires built dependencies)
- `lint` — ESLint (requires built dependencies for type-aware rules)
- `test` — Bun test runner (requires built dependencies)
- `format:check` — Prettier (independent, no dependencies)
- `validate` — runs `format:check lint check-types test` in one command

## Package Dependency Graph

Build and modify packages in dependency order:

- **Foundation** (no workspace dependencies): `interoperability`, `lifecycle`
- **Layer 1**: `armorer` (lifecycle, interoperability), `conversationalist` (lifecycle, interoperability)
- **Layer 2**: `operative` (armorer, conversationalist, interoperability, lifecycle), `memory` (armorer, interoperability)
- **Layer 3**: `herald` (armorer, conversationalist, interoperability), `sentinel` (conversationalist, lifecycle, operative)
- **Aggregator**: `gateway` (most packages), `integration` (test-only cross-package suite)

## Working on a Single Package

```bash
turbo run build --filter=<package>        # Build this package and its dependencies
turbo run test --filter=<package>         # Test this package
turbo run check-types --filter=<package>  # Type-check this package
```

Always build before type-checking or testing so downstream packages have fresh types.

## Cross-Package Changes

1. Identify all affected packages using the dependency graph above.
2. Start changes at the lowest layer and work upward.
3. Build after each layer's changes: `turbo run build --filter=<package>`.
4. Run the full pipeline before considering the change complete: `turbo run validate`.

## Workspace Dependencies

- Always use `workspace:*` protocol for internal dependencies.
- Integration tests live in `packages/integration/` and run via `turbo run integration --filter=integration`.
