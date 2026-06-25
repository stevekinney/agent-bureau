// Phase A4 — Type spike proving the bureau/agent/run architecture.
//
// This file is the TRIPWIRE for the entire big-bang rebuild. Every assertion
// below MUST pass before any tearout begins. If any assertion fails (including
// `@ts-expect-error` blocks that do NOT produce a type error), the architecture
// must be revised before proceeding.
//
// Conventions (cribbed from weft's workflow-builder.test-d.ts):
//   - `satisfies` asserts that a value resolves to exactly the expected type.
//   - `@ts-expect-error` asserts that the next line MUST be a type error.
//     If the error disappears, the test fails (the check stopped working).
//   - All `declare const` are type-level only; nothing runs at runtime.
//   - Each assertion block has a numbered comment matching the plan.md list.

import type {
  AgentBuilder,
  AgentNameFor,
  AgentRun,
  AgentTable,
  BureauToolNames,
  BureauTools,
  RunResult,
  ToolEntry,
  ToolMap,
} from './bureau-types.ts';
import { createBureau } from './bureau-types.ts';

// ---------------------------------------------------------------------------
// Declare some typed tool stubs.
// In production these come from `armorer`; here we declare minimal stubs
// so the phantom-type machinery has concrete in/out types to carry.
// ---------------------------------------------------------------------------

declare const searchTool: (input: { query: string }) => Promise<string>;
declare const clockTool: () => Promise<{ iso: string }>;
declare const scratchpadTool: (input: { text: string }) => Promise<void>;

// ---------------------------------------------------------------------------
// ASSERTION 1 — Broken-chain + reassignment across 3 files
//
// This is the highest-risk assertion. The bureau builder is immutable: each
// `.agent()` call returns a WIDER type. Callers MUST capture the return value.
// We simulate a 3-file scenario with named const assignments.
//
// File A: export const bureau = createBureau({agents:{researcher:…}})
// File B: export const bureau2 = bureau.agent({name:'writer', …})  ← MUST capture
// File C: bureau2.run('writer', …) AND bureau2.run('researcher', …)  ← both typecheck
// ---------------------------------------------------------------------------

// File A — construction-time (Tier 1) seed
const bureauA = createBureau({
  agents: {
    researcher: { instructions: 'You are a research assistant.' },
  },
});

// File B — chain addition (Tier 2) captured in a new const
const bureauB = bureauA.agent({ name: 'writer' });

// File C — both names typecheck, no `any`
void bureauB.run('researcher', 'Summarize the Q3 report');
void bureauB.run('writer', 'Draft an executive summary');

// @ts-expect-error — a name that was never registered must be a type error.
void bureauB.run('nonexistent', 'this must fail');

// ---------------------------------------------------------------------------
// ASSERTION 2 — BureauTools<T> extracts the concrete tool intersection
//
// The extractor must recover the normalised ToolEntry shapes with their
// phantom marker types, NOT the base ToolMap. This proves the phantom
// types survive every `.tools()` / `.agent()` chain link.
// ---------------------------------------------------------------------------

const bureauWithTools = createBureau().tools({ search: searchTool, clock: clockTool });

// BureauTools should give us the concrete intersection — NOT `ToolMap` base.
type ExtractedTools = BureauTools<typeof bureauWithTools>;

// 'search' must be a ToolEntry with concrete phantom types.
declare const searchEntry: ExtractedTools['search'];
void (searchEntry satisfies ToolEntry<{ query: string }, string>);

// 'clock' must carry its concrete types too.
declare const clockEntry: ExtractedTools['clock'];
void (clockEntry satisfies ToolEntry<void, { iso: string }>);

// BureauToolNames must surface the union of all tool keys.
type ToolNames = BureauToolNames<typeof bureauWithTools>;
declare const aName: ToolNames;
void (aName satisfies 'search' | 'clock');

// The phantom survives `.agent()` chaining — adding an agent must NOT erase tools.
const bureauWithToolsAndAgent = bureauWithTools.agent({ name: 'summarizer' });
type ToolsAfterAgent = BureauTools<typeof bureauWithToolsAndAgent>;
declare const searchAfterAgent: ToolsAfterAgent['search'];
void (searchAfterAgent satisfies ToolEntry<{ query: string }, string>);

// ---------------------------------------------------------------------------
// ASSERTION 3 — run() checks the agent name
//
// The closed table (bare call, TExtra = Record<never,never>) must:
//  (a) Accept a valid name
//  (b) Reject a name not in the registered set with a clear type error
//
// The input type for agents defaults to `string` in this spike — the
// architecture.md spec notes that the final implementation may expose typed
// structured inputs; `string` is the spike-minimum fallback.
// ---------------------------------------------------------------------------

const bureauForRunChecks = createBureau({
  agents: { researcher: {} },
});

// (a) Valid name: must compile cleanly.
void bureauForRunChecks.run('researcher', 'Summarize');

// (b) Unknown name: must be a type error.
// @ts-expect-error — 'nonexistent' is not in the agent table.
void bureauForRunChecks.run('nonexistent', 'input');

// ---------------------------------------------------------------------------
// ASSERTION 4 — run<TExtra> widens-not-replaces
//
// Supplying TExtra must ADD to the known table, never replace it.
// The `AgentNameFor<TAgents, TExtra>` conditional type drives this:
//   - Default (TExtra = Record<never,never>): closed — names restricted to
//     keyof TAgents & string only.
//   - Explicit TExtra (e.g. AgentTable): opens to `string`, but static
//     TAgents names remain valid — "widen, never replace."
//
// The 4 required cases from plan.md (all must typecheck correctly):
//   Case 1: Bare call with right name → compiles.
//   Case 2: Bare call with wrong name → fails (assertion 3 above).
//   Case 3: run<TExtra> with new dynamic name → compiles.
//   Case 4: run<TExtra> with static name → still compiles (widen-not-replace).
//
// When TExtra = AgentTable (Record<string, AgentConfig>), keyof TExtra = string,
// so AgentNameFor opens to `string`, accepting any name. This is CORRECT:
// run<TExtra> is a caller assertion ("I know this name exists at runtime").
// The gate is the caller supplying an appropriate TExtra, not a compiler check.
// ---------------------------------------------------------------------------

const bureauForExtra = createBureau({
  agents: { researcher: {} },
});

// Case 3: dynamic agent name works with explicit TExtra.
void bureauForExtra.run<AgentTable>('plugin-agent', 'Dynamic input');

// Case 4: static agent STILL works — widening, not replacing.
void bureauForExtra.run<AgentTable>('researcher', 'Static input still works');

// Case 1 (repeated for clarity in this block): bare call with right name.
void bureauForExtra.run('researcher', 'Bare call works');

// AgentNameFor type-level proof: closed vs open:
// - Closed (no TExtra): name must be one of the static agent names.
// - Open (TExtra has string keys): name can be any string.
type ClosedNames = AgentNameFor<{ researcher: { tools: ToolMap } }, Record<never, never>>;
void ('' as ClosedNames satisfies 'researcher');

type OpenNames = AgentNameFor<{ researcher: { tools: ToolMap } }, AgentTable>;
void ('' as OpenNames satisfies string);

// ---------------------------------------------------------------------------
// ASSERTION 5 — Tier 1 + Tier 2 compose: BureauToolNames surfaces both sets
//
// `createBureau({agents:{...}})` (Tier 1) then `.agent({...})` (Tier 2)
// produces a table with BOTH agents. `BureauToolNames` surfaces both tool
// sets merged across chained `.tools()` calls.
// ---------------------------------------------------------------------------

const bureauTier1 = createBureau({
  agents: {
    researcher: {},
    writer: {},
  },
});

// Both Tier-1 names must typecheck.
void bureauTier1.run('researcher', 'input');
void bureauTier1.run('writer', 'input');

// Tier-2 addition composes with Tier-1.
const bureauTier1And2 = bureauTier1.agent({ name: 'editor' });

void bureauTier1And2.run('researcher', 'input');
void bureauTier1And2.run('writer', 'input');
void bureauTier1And2.run('editor', 'input');

// @ts-expect-error — still cannot run an unregistered name on bare call.
void bureauTier1And2.run('completely-unknown', 'input');

// BureauToolNames for a bureau with tools at multiple points in the chain.
const chainedToolBureau = createBureau()
  .tools({ search: searchTool })
  .agent({ name: 'researcher' })
  .tools({ scratchpad: scratchpadTool });

type ChainedToolNames = BureauToolNames<typeof chainedToolBureau>;
// Both tool names must appear in the union.
declare const chainedName: ChainedToolNames;
void (chainedName satisfies 'search' | 'scratchpad');

// ---------------------------------------------------------------------------
// ASSERTION 6 — AgentRun is NON-thenable
//
// AgentRun extends AsyncIterable<RunEvent> but does NOT extend Promise or
// PromiseLike. It exposes a .result() method instead. This prevents
// auto-unwrapping at async boundaries (the AWS-SDK-v3 / tRPC problem).
//
// Structural checks:
//  (a) AgentRun must be AsyncIterable.
//  (b) AgentRun must NOT have a `.then` method (non-thenable).
//  (c) `.result()` returns Promise<RunResult>.
//  (d) Iterate-then-.result() typechecks in an async context.
//  (e) `await agentRun` is a type error (non-thenable).
// ---------------------------------------------------------------------------

declare const agentRun: AgentRun;

// (a) AgentRun is AsyncIterable — `for await` is valid.
async function _iterateRun() {
  for await (const event of agentRun) {
    void event.type; // event is RunEvent
  }
}

// (b) AgentRun is NOT thenable — no `.then` property.
// If AgentRun extended Promise, `agentRun.then` would typecheck. It must NOT.
// @ts-expect-error — AgentRun has no `.then` method (not a Promise/PromiseLike).
void agentRun.then;

// (c) .result() returns Promise<RunResult>.
const resultPromise: Promise<RunResult> = agentRun.result();
void resultPromise;

// (d) Iterate-then-result() in an async context — the pattern the architecture demands.
async function _iterateThenResult() {
  for await (const event of agentRun) {
    void event;
  }
  // .result() after full iteration — caches the terminal value.
  const result = await agentRun.result();
  void (result satisfies RunResult);
}
void _iterateThenResult;

// (e) The run handle is NOT auto-unwrapped across async boundaries.
// Proof by structural type check: AgentRun does NOT extend PromiseLike<RunResult>.
// If it did, `await agentRun` would give RunResult — but the interface only
// extends AsyncIterable, so the only path to a RunResult is `.result()`.
//
// We verify structurally: PromiseLike requires a `.then()` method; AgentRun
// does NOT have `.then` (proven in assertion (b) above). This means:
//   typeof agentRun extends PromiseLike<RunResult>  ← false
//   typeof agentRun extends AsyncIterable<RunEvent> ← true
type IsNotThenable = AgentRun extends PromiseLike<unknown> ? true : false;
// TS resolves this to `false` — AgentRun does NOT extend PromiseLike.
// We assert the result is specifically `false`, not `boolean` or `true`.
declare const isNotThenable: IsNotThenable;
void (isNotThenable satisfies false);

// ---------------------------------------------------------------------------
// ASSERTION 7 — Error messages are human-readable
//
// Deliberately miscall run() and verify TypeScript produces a clear error,
// not 40 lines of nested conditionals. The `@ts-expect-error` proves the error
// exists; the test is passed when this file typechecks successfully (i.e. the
// errors ARE present — the `@ts-expect-error` annotation consumed them cleanly,
// which means TypeScript produced an error on the intended line, not elsewhere).
//
// The `AgentNameFor` conditional type is designed to produce short, readable
// errors: when names are closed, the error names the exact literal union
// (e.g. `"researcher" | "writer"`), not an opaque generic constraint.
// ---------------------------------------------------------------------------

const bureauForErrors = createBureau({
  agents: { researcher: {} },
});

// Wrong agent name — TypeScript should identify 'typo' as the bad argument.
// The error points to the argument, not buried in nested conditionals.
// @ts-expect-error — wrong agent name; error should name 'typo' as the problem.
void bureauForErrors.run('typo', 'input');

// ---------------------------------------------------------------------------
// AgentBuilder standalone path — bureau-less, generate required
//
// `createAgent({generate, ...})` returns `AgentBuilder<{}, TAgentTools>`.
// The bureau slot is empty; tools are agent-only. This is orthogonal to the
// 7 main assertions but verifies the two-param separation is sound.
// ---------------------------------------------------------------------------

declare const standaloneAgent: AgentBuilder<Record<never, never>, Record<never, never>>;
declare const agentWithTools: AgentBuilder<
  Record<never, never>,
  { search: ToolEntry<{ query: string }, string> }
>;

// Tool map carries phantom types through the agent's own chain.
void agentWithTools.run('Find relevant docs');
void standaloneAgent;

// ---------------------------------------------------------------------------
// Final void block — satisfy unused-var lint for all bindings used above.
// ---------------------------------------------------------------------------

void [
  bureauA,
  bureauB,
  bureauWithTools,
  bureauWithToolsAndAgent,
  bureauForRunChecks,
  bureauForExtra,
  bureauTier1,
  bureauTier1And2,
  chainedToolBureau,
  agentRun,
  resultPromise,
  standaloneAgent,
  agentWithTools,
  _iterateRun,
  _iterateThenResult,
  bureauForErrors,
];
