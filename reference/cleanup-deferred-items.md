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

### operative run-runtime (weft lands here)

- `create-run.ts` `forwardEvents` uses `as unknown as ForwardableSource` casts (lines ~74, 81) to
  bridge an EventTarget-vs-Toolbox/Conversation type gap. Fixing properly means adding
  ForwardableSource conformance to armorer/conversationalist types — a cross-layer change **weft may
  obviate**. Defer to land with/after weft.
- `scheduler/sleep.ts` has a Symbol-based runtime override seam — this is exactly the injection point
  **weft will use** to supply its own sleep/timer runtime. It works today. Document + export the
  override symbol _with_ the weft integration (so the docs match weft's real usage), not speculatively.

### integration `.mjs` test files (`runtime.test.mjs`, `runtime-helpers.mjs`)

The only `.mjs` files in the repo; they violate the TS-only convention BUT intentionally run under the
**Node.js test runner** (`node:test`/`node:assert`) to validate Node-runtime interop. Converting them
to `bun:test` would change _what_ they test (lose Node-compat coverage). weft brings cross-runtime
durable-execution concerns that may reshape this suite — revisit the conversion then.

### build-toolchain standardization (open A/B/C decision)

Eight packages use a hand-rolled `scripts/build.ts` (bureau, cloudflare, evaluation, gateway,
interoperability, lifecycle, memory, skills); armorer, conversationalist, and operative use `tsdown`.
Options: (A) migrate all to tsdown, (B) extract a shared `buildLibrary()` helper, (C) leave as-is.
**Deferred** — it touches every package's build at once, eases nothing for cinder/weft specifically,
and is risky right before a refactor. Decide A-vs-B during stabilization.

gateway stays special regardless — but _not_ because of entry count. Every tsdown config in the repo
already hands `defineConfig` a multi-entry map (`packages/armorer/tsdown.config.ts`,
`packages/conversationalist/tsdown.config.ts`, `packages/operative/tsdown.config.ts` declare
20, 19, and 27 entries respectively), so "one entry per build" is not a real tsdown constraint and
must not be used to justify the exemption. The actual reason is that
`packages/gateway/scripts/build.ts` is not a library build at all. It:

- runs two `Bun.build` passes over different graphs with `SveltePlugin()` — `target: 'bun'` for the
  SSR pass (which compiles `.svelte` to server output) and `target: 'browser'` for the hydration pass
  (which compiles the same components to client output);
- concatenates the client pass's CSS outputs with `packages/gateway/src/ui/styles/*.css` into a single
  `dist/public/styles.css`, and fails the build if required Cinder selectors are missing from it;
- writes `dist/manifest.json` mapping logical names to content-hashed client filenames, which
  `src/server/render.ts` reads to emit script/style URLs.

tsdown's job is emitting a library's ESM/CJS/`.d.ts` from source entries; it produces none of that
application output (dual-target Svelte compilation, a composed stylesheet, a hash manifest). Revisit
the exemption only if the CSS pipeline and manifest move out of the build script — not on entry count.

## Resolved since the cleanup pass (not todos)

### gateway UI + dual server/client build — the cinder migration has landed

_Historical context:_ the 2026-06-02 pass deferred all cleanup of gateway's UI tree and build script
because a cinder-based rewrite was pending and expected to delete the code. **That constraint is
over — do not apply it to current work.**

Gateway's UI is Svelte today:

- `packages/gateway/src/ui/*` holds `.svelte` components (`components/`) and pages (`pages/`), plus
  app stylesheets in `packages/gateway/src/ui/styles/`.
- The rune-based hooks live in `packages/gateway/src/ui/hooks/`:
  `packages/gateway/src/ui/hooks/use-chat.svelte.ts`,
  `packages/gateway/src/ui/hooks/use-runs.svelte.ts`,
  `packages/gateway/src/ui/hooks/use-run-detail.svelte.ts`,
  `packages/gateway/src/ui/hooks/use-reviews.svelte.ts`,
  `packages/gateway/src/ui/hooks/use-websocket.svelte.ts`, and the plain (non-rune) helper
  `packages/gateway/src/ui/hooks/tool-activity.ts`.
- `packages/gateway/src/client/entry.ts` is the hydration entry.
- `packages/gateway/scripts/build.ts` runs one pipeline with two `Bun.build` passes — an SSR pass
  (`target: 'bun'`) and a hydration pass (`target: 'browser'`), both loading `SveltePlugin()` — then
  writes `dist/manifest.json` and `dist/public/styles.css`.

Consequences for cleanup work: this is live production code, so test it and clean it like any other
package. The UI hooks and pages already carry `*.test.ts` coverage; keep adding to it. The two-pass
build remains structurally unique (see the build-toolchain note above) and stays on its own
`scripts/build.ts`.

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
