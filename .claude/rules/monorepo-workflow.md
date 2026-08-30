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

## Ad Hoc Scripts Against Workspace Package Code

Bun's workspace linking resolves an internal import like `import { Conversation } from 'conversationalist'` to that package's `dist/`, not its `src/`. The `build`/`test`/`check-types` pipeline above is Turborepo-driven: Turborepo's task graph rebuilds stale dependents automatically via `^build`, so those tasks always see current code. A plain `bun run <file>.ts` outside that graph has no such guarantee — it can silently resolve a `dist/` that predates the `src/` you just edited, producing a false-positive bug report against stale, already-fixed code (this happened for real: AB-146).

Before running any ad hoc script (`bun run <file>.ts`) against workspace package code — as opposed to `build`/`test`/`check-types`, which already handle this correctly for their own tasks — run the staleness guard first:

```bash
bun run check:stale-dist
```

It walks every workspace package with both a `src/` and a `dist/` directory and, for each one, compares its newest `dist/` mtime against the newest `src/` mtime across that package AND all of its transitive workspace dependencies (resolved by package NAME from `dependencies`/`devDependencies`, since internal deps mix the `workspace:*` protocol with plain semver ranges) — exiting non-zero naming every package that's stale either way. `armorer` and `conversationalist` inline `lifecycle` and `interoperability` at build time, so rebuilding `lifecycle` without rebuilding its consumers is exactly the kind of gap this closes. Run `turbo run build` (or `turbo run build --filter=<package>`) to clear a failure before continuing with the ad hoc script.

This guard is a fast mtime heuristic, not a proof of freshness. It includes directory mtimes as well as file mtimes, which catches the common case of a deleted source file (removing a file bumps its parent directory's mtime on macOS and Linux) — but it can still miss a deletion on a filesystem that doesn't update directory mtimes on unlink, and it can't detect a content change that doesn't touch mtime at all. `turbo run build` remains the authority on whether `dist/` is actually current; treat this guard as a cheap tripwire for ad hoc scripts, not a replacement for it.
