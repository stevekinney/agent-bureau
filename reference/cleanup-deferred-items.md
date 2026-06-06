# Pre-Integration Cleanup — Deferred Items

This file records work that was **intentionally deferred** during the 2026-06-02 pre-integration
cleanup pass, with the rationale, so the cinder/weft integration session (2026-06-03) inherits the
context and does not relitigate these decisions.

## What the cleanup pass landed

Real, gated commits across every dependency layer (all behind the full `validate` pre-commit hook):

- Removed dead code: vendored 396 KB `reference/agent.ts`, dead hand-rolled `scripts/build.ts` in
  armorer/conversationalist (tsdown is canonical), unused `change-case` dep, stale `./persistence`
  subpath export.
- Killed the **fake-green gates**: `interoperability` and `integration` had no ESLint at all
  (turbo silently skipped them); a since-removed vector-storage package's lint was a no-op `echo`
  stub hiding 162 real violations. All packages now genuinely lint clean.
- Deduped real duplication: herald status-code extraction (3 copies → 1), gateway
  `createSkillSession`/`escapeXml` (reuse from `skills`).
- Fixed + enforced armorer's `check:boundaries` (was failing silently; now part of `lint`).
- turbo: tracked root configs in `globalDependencies`, cache `coverage/**`.

## Deferred — do NOT polish before the integration rewrites them

### gateway `src/ui/*` + dual server/client build (`scripts/build.ts`)
**cinder (Svelte UI) replaces this entire React tree today.** It is *wired and live* (client/entry.tsx
hydrates ui/app; build.ts compiles the browser bundle + SSR pages) — NOT dead code, despite knip
false positives. Do not delete it ahead of cinder, do not write tests for use-chat/use-runs/
use-websocket/run-detail, do not extract `formatDetail`. The dual-build (Hono server target:bun +
React client target:browser) is structurally unique; tsdown's single-entry model doesn't fit.
Reassess the build approach once cinder defines the new client output format (Svelte, not tsx).

### operative run-runtime (weft lands here)
- `create-run.ts` `forwardEvents` uses `as unknown as ForwardableSource` casts (lines ~74, 81) to
  bridge an EventTarget-vs-Toolbox/Conversation type gap. Fixing properly means adding
  ForwardableSource conformance to armorer/conversationalist types — a cross-layer change **weft may
  obviate**. Defer to land with/after weft.
- `scheduler/sleep.ts` has a Symbol-based runtime override seam — this is exactly the injection point
  **weft will use** to supply its own sleep/timer runtime. It works today. Document + export the
  override symbol *with* the weft integration (so the docs match weft's real usage), not speculatively.

### integration `.mjs` test files (`runtime.test.mjs`, `runtime-helpers.mjs`)
The only `.mjs` files in the repo; they violate the TS-only convention BUT intentionally run under the
**Node.js test runner** (`node:test`/`node:assert`) to validate Node-runtime interop. Converting them
to `bun:test` would change *what* they test (lose Node-compat coverage). weft brings cross-runtime
durable-execution concerns that may reshape this suite — revisit the conversion then.

### build-toolchain standardization (open A/B/C decision)
11 packages use a hand-rolled `scripts/build.ts`; armorer/conversationalist use `tsdown`. Options:
(A) migrate all to tsdown, (B) extract a shared `buildLibrary()` helper, (C) leave as-is.
**Deferred** — it touches every package's build at once, eases nothing for cinder/weft specifically,
and is risky right before a refactor. Decide A-vs-B during stabilization. gateway stays special
regardless (dual build).

## Closed decisions (not todos)

- **knip / "unused export = dead code" gates: decided AGAINST.** agent-bureau is a library that builds
  public API ahead of its consumers on purpose; knip's core heuristic fights that and a passing gate
  would require an ever-growing ignore-config (a new fake-green gate). Use real lint + coverage +
  boundary checks instead. Do not re-propose.
- **retry/backoff dedup (armorer ↔ the since-removed vector-storage package): considered, deemed
  premature.** The two impls had diverged (armorer lacks `linear`, has a `≤0→0` guard, different field
  names); extracting ~6 lines of arithmetic to `interoperability` would couple two packages over
  trivial math. Not debt. (Moot now that the second package is gone.)
- **memory `ConversationLike`/`MessageLike` dedup: considered, low value.** `MessageLike` is identical
  across `experiential.ts` and `hooks/create-memory-hooks.ts`, but `ConversationLike` has forked (the
  hooks variant adds `appendSystemMessage`). A within-package extract of just `MessageLike` is a safe
  5-minute cleanup if ever wanted, but not worth doing now.
