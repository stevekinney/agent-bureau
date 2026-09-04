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

- **Foundation** (no workspace dependencies): `lifecycle`
- **Layer 1**: `interoperability` (lifecycle), `armorer` (lifecycle, interoperability), `conversationalist` (lifecycle, interoperability)
- **Layer 2**: `operative` (armorer, conversationalist, interoperability, lifecycle), `memory` (armorer, interoperability, lifecycle)
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

## The Pre-Commit Hook Is Not The Gate

`lefthook.yml` runs `format` (staged files only), `lint`, and `check-types` — roughly two seconds once Turborepo has those tasks cached. It deliberately does **not** run the test suite.

CI is the authoritative gate: `.github/workflows/ci.yml` runs the full build, lint, type-check, test, coverage, and package-shape matrix on every pull request and blocks the merge. The hook exists for fast local feedback, not to duplicate that.

Do not add the test suite back to the hook. It was removed on evidence, not preference: it cost 60–80s on every commit, duplicated a required CI check, and — because several integration tests do real multi-step runs against a 5s default budget — failed intermittently on a machine shared with other work, for reasons unrelated to the change being committed. `format` was likewise narrowed from an 80–110s whole-repository `prettier --check` to the staged files. See AB-188 for the measurements.

If the hook blocks you, fix the finding — never `--no-verify`, which the working agreements prohibit. If a task is slow because its Turborepo cache is cold, run `turbo run lint check-types` once and the hook replays from cache.

## Ad Hoc Scripts Against Workspace Package Code

Bun's workspace linking resolves an internal import like `import { Conversation } from 'conversationalist'` to that package's `dist/`, not its `src/`. The `build`/`test`/`check-types` pipeline above is Turborepo-driven: Turborepo's task graph rebuilds stale dependents automatically via `^build`, so those tasks always see current code. A plain `bun run <file>.ts` outside that graph has no such guarantee — it can silently resolve a `dist/` that predates the `src/` you just edited, producing a false-positive bug report against stale, already-fixed code (this happened for real: AB-146).

Before running any ad hoc script (`bun run <file>.ts`) against workspace package code — as opposed to `build`/`test`/`check-types`, which already handle this correctly for their own tasks — run the staleness guard first:

```bash
bun run check:stale-dist
```

It walks every workspace package with both a `src/` and a `dist/` directory and, for each one, compares its newest `dist/` mtime against the newest `src/` mtime across that package AND all of its transitive workspace dependencies (resolved by package NAME from `dependencies`/`devDependencies`, since internal deps mix the `workspace:*` protocol with plain semver ranges) — exiting non-zero naming every package that's stale either way. `armorer` and `conversationalist` inline `lifecycle` and `interoperability` at build time, so rebuilding `lifecycle` without rebuilding its consumers is exactly the kind of gap this closes. Run `turbo run build` (or `turbo run build --filter=<package>`) to clear a failure before continuing with the ad hoc script. If that reports `FULL TURBO` and the guard still fails, the skew is mtime-only with unchanged content: Turborepo hashes content, so a cached build leaves `dist/` mtimes untouched and the guard stays red. `turbo run build --force` clears that case.

This guard is a fast mtime heuristic, not a proof of freshness, and it has two known blind spots worth knowing before you trust it:

- **Deleted source files are invisible.** Nothing left in `src/` gets a newer mtime, so a `dist/` still carrying the deleted module reads as fresh. Counting directory mtimes would catch this, and was tried and reverted: several suites create and delete fixture directories _inside_ `src/` while running, so it made the guard fail after a plain `turbo run test` with no source edits at all. A tripwire that fires after an ordinary test run is worse than one with a documented gap.
- **mtime skew without a content change reads as stale.** A `touch`, or a branch switch that rewrites mtimes, trips the guard even though `dist/` is current — and because Turborepo hashes content, `turbo run build` is a cache hit that cannot clear it. Use `turbo run build --force`.

`turbo run build` remains the authority on whether `dist/` is actually current; treat this guard as a cheap tripwire for ad hoc scripts, not a replacement for it.
