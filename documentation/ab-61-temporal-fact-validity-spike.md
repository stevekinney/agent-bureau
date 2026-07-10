# AB-61 — Temporal fact-validity spike (Zep-style validity windows on our own memory records)

Status: SPIKE, complete. Prototype merged behind `CreateMemoryOptions.experimentalTemporalValidity` (default `false`). This document is the design writeup + go/no-go recommendation for Steve.

Per the AB-65 ruling, this is first-party only: no Zep client, no vendored Zep concepts beyond the general idea ("facts have a validity window; a new fact can supersede an old one; recall can be asked what was true at a point in time"). Everything here is implemented against our own `MemoryRecordStorage` / `createMemory` pipeline.

## Problem

Today a memory record is either present or forgotten. There's no notion that a _fact_ can become false while the _record_ stays around for history — "the team lead is Alex" and, three months later, "the team lead is Jordan" just sit side-by-side in `recall()` results with no signal that the second supersedes the first. Two consequences:

1. `recall()` can surface a stale fact alongside its replacement, and the caller (often an LLM) has no structural signal for which one is current.
2. There's no way to ask "what did we believe as of last Tuesday" — useful for auditing agent decisions, debugging why an agent acted on since-corrected information, or reconstructing state at a point in time.

## Design

### Data model — new optional metadata fields, no storage schema change

`MemoryRecordStorage.MemoryRecord.metadata` is already an open `Record<string, unknown>` bag (see `packages/memory/src/memory-record-storage.ts`). Temporal validity is layered entirely as metadata conventions — no backend migration, no new storage method, works identically across the in-memory, Weft, and (eventually) Cloudflare backends:

| Field           | Type                                 | Meaning                                                                                                                                                                                |
| --------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validFrom`     | `number` (epoch ms), optional        | Start of the fact's validity window. Defaults to the record's `createdAt` when unset. Set explicitly to backdate a fact that was true before it was recorded (e.g. importing history). |
| `invalidatedAt` | `number` (epoch ms), optional        | End of the validity window, **exclusive**. Unset for a currently-valid fact.                                                                                                           |
| `supersededBy`  | `string` (record id), optional       | The record that invalidated this one. Set alongside `invalidatedAt`.                                                                                                                   |
| `supersedes`    | `string` (record id), **write-only** | Passed to `remember()` as an instruction, not persisted. Names the record this new fact supersedes.                                                                                    |

A record is valid at instant `t` iff `validFrom <= t < invalidatedAt` (or `invalidatedAt` is unset). This is a plain half-open interval — implemented once, in `packages/memory/src/temporal-validity.ts`, as pure functions:

```ts
isValidAtTimestamp(metadata, createdAt, asOf): boolean
filterByValidity(results, asOf): T[]      // pure filter, does not mutate
stampSupersession(metadata, supersededBy, invalidatedAt): Record<string, unknown>
```

No classes, no new abstraction layer — three functions, mirroring the existing style of `temporal-decay.ts` (`computeTemporalDecay` / `applyTemporalDecay`) exactly, so the pipeline gains one more `apply*`-shaped stage instead of a bespoke subsystem.

### Fact supersession — `remember()` extension

`createMemory({ ..., experimentalTemporalValidity: true })` unlocks:

```ts
const original = await memory.remember('The team lead is Alex');
const successor = await memory.remember('The team lead is Jordan', {
  supersedes: original.id,
});
```

`remember()`'s existing flow (embed → dedup/conflict check → insert) is untouched; supersession is appended as a fourth step, only on the plain-insert path:

1. Insert the new record as normal (so a failed supersession stamp never leaves an orphaned successor with nothing pointing at it — the new fact is durable before the old one is touched).
2. `storage.get(supersedes, scope)` the target. If it doesn't exist in scope, throw (`Cannot supersede unknown record "…"`) — fail loud rather than silently no-op, since a spike consumer debugging a chain wants to know immediately if an id was wrong or cross-namespace.
3. `storage.update(target.id, scope, { metadata: stampSupersession(target.metadata, newId, now) })`.

`supersedes` is stripped from the new record's own stored metadata by `buildStoredMetadata` (same treatment as `namespace` — it's a directive, not a fact attribute) so it never leaks into `toMemoryMetadata()` output.

Chains work by construction: superseding B (which already supersedes A) just stamps B, leaving A's existing `supersededBy: B` alone. Walking a chain is `id -> supersededBy -> supersededBy -> …` until unset, or reconstructable purely from `asOf` recall (see below) without ever walking pointers by hand.

Calling `remember()` with `supersedes` while the flag is off throws immediately — the option is inert by default, so existing `createMemory()` consumers see zero behavior change.

### As-of recall — `recall({ asOf })` extension

`MemorySearchOptions.asOf?: number` (epoch ms). When `experimentalTemporalValidity` is on:

- `asOf` defaults to `Date.now()` when omitted — i.e. plain `recall()` with the flag on shows only currently-valid facts, which is almost certainly what a caller wants by default (a superseded fact competing with its own successor for the same query is the exact staleness problem this spike targets).
- `asOf` set to a past instant answers "what was true then," including facts that have since been superseded.

**Integration point, not a fork.** `filterByValidity` runs immediately after the vector/hybrid search produces its scored candidate list, before `applyTemporalDecay` and `applyMaximalMarginalRelevance` — both existing pipeline stages — ever see the results. Concretely, in `createMemory.recall()`:

```
searchByVector / hybrid merge
  → filterByValidity(results, asOf)     // NEW — as-of window
  → applyTemporalDecay(...)             // existing, unchanged
  → applyMaximalMarginalRelevance(...)  // existing, unchanged
  → source-document dedup, limit, strip vectors
```

This is the same shape `temporalDecay` and `diversify` already use (opt-in, one extra `apply*`-style stage), applied identically in both the `vectorOnly` branch and the hybrid BM25+vector branch, so both recall modes get consistent as-of semantics. Nothing about hybrid merging, BM25 scoring, or MMR needed to change — validity is a pre-filter on the candidate pool, exactly like a threshold cut.

One caveat worth flagging for the go/no-go: because filtering happens _after_ the vector/BM25 top-K cutoff (`limit * candidateMultiplier` candidates are fetched before filtering), a query where most of the top-K matches happen to be invalidated at the requested `asOf` can return fewer than `limit` results, or even zero, despite valid matches existing further down the similarity ranking. This is the same class of limitation the existing source-document dedup step already has (dedup also shrinks the post-cutoff pool) — acceptable for a spike, worth a widened candidate multiplier or two-pass fetch if this graduates.

### Why metadata, not a schema change

Considered and rejected: adding `validFrom`/`invalidatedAt` as first-class `MemoryRecord` fields (alongside `id`, `content`, `vector`, …). Rejected because:

- It would require every `MemoryRecordStorage` implementation (in-memory, Weft, future Cloudflare/PGLite) to add columns/fields and migrate the contract test harness (`runMemoryRecordStorageContract`) — a real cross-backend commitment for what is currently a P2 spike.
- The existing metadata bag already round-trips arbitrary extension keys through `put`/`update`/`get`/`list`/`searchByVector` for every backend, so the spike gets full persistence, filtering, and querying for free with zero backend work.
- If this graduates past spike status, promoting `validFrom`/`invalidatedAt` to first-class columns (for indexed range queries at scale) is a natural, backward-compatible follow-up — the metadata convention is the correct MVP shape either way.

## What was prototyped

- `packages/memory/src/temporal-validity.ts` — the three pure functions above.
- `packages/memory/src/types.ts` — `MemoryMetadata.{validFrom,invalidatedAt,supersededBy,supersedes}`, `MemorySearchOptions.asOf`, `CreateMemoryOptions.experimentalTemporalValidity`.
- `packages/memory/src/create-memory.ts` — supersession stamping in `remember()`, as-of filtering in both `recall()` branches, all behind the flag.
- Tests:
  - `packages/memory/test/temporal-validity.test.ts` — pure-function unit tests (window edges, chain overwrite, non-mutation).
  - `packages/memory/test/temporal-validity-recall.test.ts` — integration tests against `createMemory`: flag gating (on/off), supersession stamping, unknown-id error, a three-link supersession chain, as-of recall resolving to the correct link at each point in the chain, hybrid-path filtering (not just `vectorOnly`), and an explicit `validFrom` backdate.
  - Regression tests were neuter-verified: stubbing `filterByValidity` to a no-op and `stampSupersession` to an identity function drops 11 of 19 tests to failing, confirming they exercise the real behavior, not vacuously pass.

All new/changed code passes `bun run check-types`, `turbo run lint --filter=memory`, and the full `packages/memory` test suite (580 pass).

## Go / no-go recommendation

**Recommendation: no-go on graduating to a stable, always-on feature yet — go on keeping it as an experimental opt-in and running the benchmark below before deciding.**

Reasoning:

- The mechanism is cheap and non-invasive (it already ships behind a flag with zero cost to existing consumers), so there's no forcing reason to decide now.
- The open question that should gate graduation isn't implementation risk — it's **retrieval quality**: does as-of filtering + supersession actually improve answer correctness on temporal questions, or does it just add API surface nobody exercises? That's an empirical question the design doc can't answer; it needs the benchmark.
- The known limitation above (post-cutoff filtering can starve the candidate pool) should be measured, not guessed at, before deciding whether it needs a fix (widen the multiplier, or push validity filtering into `storage.searchByVector` itself) prior to graduation.

### Benchmark plan (for Steve to run/commission — not started as part of this spike)

Use a **subset of LongMemEval** (the temporal-reasoning-focused subset, plus the knowledge-update subset) rather than the full suite:

1. **Scope**: pull the `temporal-reasoning` and `knowledge-update` question categories only (these are the ones that actually exercise validity windows and supersession — the other LongMemEval categories, e.g. multi-session reasoning or abstention, aren't targeted by this spike).
2. **Corpus construction**: ingest each session's memories via `memory.remember()` in session order, using `metadata.supersedes` wherever a later session's fact contradicts an earlier one (LongMemEval's knowledge-update items are explicitly constructed this way — the "old" and "new" fact pairs are labeled in the dataset).
3. **Two conditions, same corpus**:
   - **Baseline**: `experimentalTemporalValidity: false`, plain `recall()`.
   - **Treatment**: `experimentalTemporalValidity: true`, `recall()` with no `asOf` (defaults to now) for "what's true now" questions, and `recall({ asOf: <question's reference timestamp> })` for explicit as-of questions.
4. **Metric**: accuracy against LongMemEval's provided gold answers, comparing baseline vs. treatment on the same question set. Secondary metric: candidate-pool starvation rate (how often as-of filtering returns fewer than `limit` results) to validate or dismiss the cutoff-order caveat above.
5. **Decision rule**: if treatment shows a material accuracy lift on the temporal-reasoning/knowledge-update subset with no regression elsewhere (run the full LongMemEval subset list, not just these two categories, to check for regressions on categories the flag shouldn't touch), graduate `experimentalTemporalValidity` toward default-on and consider first-class storage fields. If the lift is marginal or absent, keep it as an opt-in escape hatch (or shelve it) rather than investing further.

This spike deliberately stops before running that benchmark — implementing it is the recommended next step, not part of AB-61's scope.
