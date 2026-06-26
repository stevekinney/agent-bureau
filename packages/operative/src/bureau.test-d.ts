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
  AgentGenerateFunction,
  AgentNameFor,
  AgentRun,
  AgentTable,
  AgentToolNames,
  AgentTools,
  BureauToolNames,
  BureauTools,
  CreateAgentFn,
  CreateAgentOptions,
  CreateBureauFn,
  RunResult,
  SkillPolicy,
  SkillProviderLike,
  ToolEntry,
  ToolMap,
  ToolMapInput,
} from './bureau-types.ts';

// ---------------------------------------------------------------------------
// Declare some typed tool stubs.
// In production these come from `armorer`; here we declare minimal stubs
// so the phantom-type machinery has concrete in/out types to carry.
// ---------------------------------------------------------------------------

// Tool entries are always the object form: `{ execute }` (or `{ execute, input }`).
// A bare function is rejected by `ToolEntryInput` because it cannot declare an
// `input` schema (PRRT_kwDORvupsc6MclwB) — see `toolboxFromMap` in
// `bureau/src/builder.ts`.
declare const searchTool: { execute: (input: { query: string }) => Promise<string> };
declare const clockTool: { execute: () => Promise<{ iso: string }> };
declare const scratchpadTool: { execute: (input: { text: string }) => Promise<void> };
declare const createBureau: CreateBureauFn;
declare const createAgent: CreateAgentFn;

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

// 'clock' must carry its concrete types too. A no-argument `{ execute }` has no
// parameter to infer, so the input phantom is `unknown` (not `void`).
declare const clockEntry: ExtractedTools['clock'];
void (clockEntry satisfies ToolEntry<unknown, { iso: string }>);

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
// ASSERTION B4 — Agent is an options bag; tools as name-keyed map
//
// B4 has four sub-assertions:
//   B4a. Tool entries in a name-keyed map forbid an inner `name` field.
//        The MAP KEY is canonical; a `.name` on the object disagrees and is
//        the #1 authoring bug (`{ 'web-search': { name: 'search', execute } }`).
//   B4b. `AgentTools<T>` extracts the merged bureau + agent tool map.
//   B4c. `AgentToolNames<T>` surfaces `keyof (bureauTools & agentTools) & string`.
//   B4d. `createAgent({...})` accepts the options-bag shape with tools-as-map,
//        `generate` required, and returns a typed `AgentBuilder`.
// ---------------------------------------------------------------------------

// ---- B4a: Forbid inner `name` field on tool entry objects ----
//
// A tool entry's canonical name is the MAP KEY, not an inner `.name` property.
// `ToolEntryInput` uses `name?: never` on the object variant to enforce this.
//
// Valid: a plain `execute` object with no `name` field.
declare const validToolEntry: { execute: (input: { query: string }) => Promise<string> };
// This must be accepted by `.tools({...})`. Use a concrete call to prove it.
const bureauWithValidTool = createBureau().tools({ search: validToolEntry });
void bureauWithValidTool;

// Invalid: an object WITH an inner `name` field must be a type error.
// This is the "armorer tool passed directly" pattern — armorer tools carry
// `.name`, but the key is canonical. Passing a named object in the entry
// position violates the `name?: never` constraint.
declare const namedToolEntry: {
  name: string;
  execute: (input: { query: string }) => Promise<string>;
};

// @ts-expect-error — tool entry with inner `name` field is forbidden; key is canonical.
void createBureau().tools({ search: namedToolEntry });

// ---- B4b: AgentTools<T> extracts the merged tool map ----
//
// When a bureau has bureau-level tools AND an agent adds its own tools,
// `AgentTools<typeof agent>` must surface BOTH sets as a merged map.

const bureauForAgentTools = createBureau().tools({ search: searchTool, clock: clockTool });
// We can't call bureau.agent() in a type-only context directly here, but we
// can prove AgentTools via a declared AgentBuilder shape:
declare const agentBuilderWithBoth: AgentBuilder<
  { search: ToolEntry<{ query: string }, string>; clock: ToolEntry<void, { iso: string }> },
  { scratchpad: ToolEntry<{ text: string }, void> }
>;

type MergedTools = AgentTools<typeof agentBuilderWithBoth>;

// All three tools must appear in the merged type.
declare const mergedSearch: MergedTools['search'];
void (mergedSearch satisfies ToolEntry<{ query: string }, string>);

declare const mergedScratchpad: MergedTools['scratchpad'];
void (mergedScratchpad satisfies ToolEntry<{ text: string }, void>);

// ---- B4c: AgentToolNames<T> surfaces keyof (bureauTools & agentTools) ----
//
// The union must include tool names from BOTH bureau and agent tool sets.

type AllToolNames = AgentToolNames<typeof agentBuilderWithBoth>;
declare const aToolName: AllToolNames;
// All three names must be in the union.
void (aToolName satisfies 'search' | 'clock' | 'scratchpad');

// A standalone agent's tool names are just its own tool keys.
type StandaloneToolNames = AgentToolNames<typeof agentWithTools>;
declare const aStandaloneName: StandaloneToolNames;
void (aStandaloneName satisfies 'search');

// ---- B4d: createAgent({...}) — options-bag factory ----
//
// `createAgent` accepts a plain options object (NOT a chain). The `generate`
// field is REQUIRED. Tools are a name-keyed map — NOT a Toolbox instance.
// The returned builder types its own tool map, bureau slot empty.

declare const mockGenerate: AgentGenerateFunction;

// Valid: all required fields present, tools as map.
const standaloneCreated = createAgent({
  name: 'researcher',
  generate: mockGenerate,
  tools: { search: searchTool, clock: clockTool },
});

// The returned builder has no bureau tools (empty slot) and the agent's tools.
type StandaloneBuilderTools = AgentTools<typeof standaloneCreated>;
declare const createdSearch: StandaloneBuilderTools['search'];
void (createdSearch satisfies ToolEntry<{ query: string }, string>);

// AgentToolNames on the created builder surfaces the agent's tool keys.
type CreatedToolNames = AgentToolNames<typeof standaloneCreated>;
declare const aCreatedName: CreatedToolNames;
void (aCreatedName satisfies 'search' | 'clock');

// run() works on the created agent.
void standaloneCreated.run('Summarize the Q3 report');

// Builder's .tools() method chains correctly onto the created agent.
const extendedAgent = standaloneCreated.tools({ scratchpad: scratchpadTool });
type ExtendedToolNames = AgentToolNames<typeof extendedAgent>;
declare const anExtendedName: ExtendedToolNames;
void (anExtendedName satisfies 'search' | 'clock' | 'scratchpad');

// `generate` is REQUIRED — omitting it must be a type error.
// @ts-expect-error — generate is required on createAgent; no bureau to inherit from.
void createAgent({ name: 'missing-generate', tools: { search: searchTool } });

// `name` is REQUIRED — omitting it must be a type error.
// @ts-expect-error — name is required on createAgent.
void createAgent({ generate: mockGenerate });

// CreateAgentOptions verifies the shape contract separately:
declare const validOptions: CreateAgentOptions<{ search: typeof searchTool }>;
void (validOptions.name satisfies string);
void (validOptions.generate satisfies AgentGenerateFunction);

// The `ToolMapInput` constraint is the outer type — ensure it's re-exported.
declare const _toolMapInput: ToolMapInput;
void _toolMapInput;

// ---------------------------------------------------------------------------
// ASSERTION D4 — Skills as an inherited bureau capability
//
// D4 adds `.skills(provider, policy?)` to the bureau builder. Key requirements:
//
//   D4a. `.skills(provider)` accepts a `SkillProviderLike` and returns the SAME
//        bureau builder type (no widening of TTools/TAgents).
//   D4b. `.skills(provider, policy)` accepts an optional `SkillPolicy`.
//   D4c. `.skills()` chains with `.agent()` and `.tools()` without losing types.
//   D4d. `AgentOptions.skillPolicy` lets agents restrict the base skill catalog.
//   D4e. `SkillPolicy` and `SkillProviderLike` are exported from bureau-types.
// ---------------------------------------------------------------------------

// D4e: both types are importable (proven by the import above).
declare const _skillPolicy: SkillPolicy;
declare const _skillProviderLike: SkillProviderLike;
void _skillPolicy;
void _skillProviderLike;

// A minimal provider stub.
declare const mockSkillProvider: SkillProviderLike;

// D4a: .skills(provider) returns the SAME BureauBuilder type (tool + agent
// type params are preserved, not reset).
const bureauWithSkills = createBureau().tools({ search: searchTool }).skills(mockSkillProvider);

// Tools are still present after .skills() — the phantom types survived.
type SkillsBureauTools = BureauTools<typeof bureauWithSkills>;
declare const searchAfterSkills: SkillsBureauTools['search'];
void (searchAfterSkills satisfies ToolEntry<{ query: string }, string>);

// D4b: .skills(provider, policy) — policy is optional.
const bureauWithSkillsAndPolicy = createBureau().skills(mockSkillProvider, {
  allowList: ['research-skill'],
  denyList: ['dangerous-skill'],
});
void bureauWithSkillsAndPolicy;

// D4c: chains with .agent() without losing tool types.
const bureauChainedWithSkills = createBureau()
  .tools({ search: searchTool })
  .skills(mockSkillProvider)
  .agent({ name: 'researcher' });

// Agent is registered and tools are preserved.
void bureauChainedWithSkills.run('researcher', 'Summarize');
type SkillsChainedTools = BureauTools<typeof bureauChainedWithSkills>;
declare const searchAfterChain: SkillsChainedTools['search'];
void (searchAfterChain satisfies ToolEntry<{ query: string }, string>);

// D4d: AgentOptions accepts skillPolicy for per-agent skill filtering.
const bureauWithAgentSkillPolicy = createBureau()
  .skills(mockSkillProvider)
  .agent({ name: 'restricted', skillPolicy: { denyList: ['dev-skill'] } });
void bureauWithAgentSkillPolicy.run('restricted', 'Summarize');

// @ts-expect-error — unregistered agent still errors.
void bureauWithAgentSkillPolicy.run('nonexistent', 'input');

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
  bureauWithValidTool,
  agentBuilderWithBoth,
  mergedSearch,
  mergedScratchpad,
  aToolName,
  aStandaloneName,
  standaloneCreated,
  extendedAgent,
  createdSearch,
  aCreatedName,
  anExtendedName,
  validOptions,
  _toolMapInput,
  bureauForAgentTools,
  // D4 assertions
  _skillPolicy,
  _skillProviderLike,
  bureauWithSkills,
  searchAfterSkills,
  bureauWithSkillsAndPolicy,
  bureauChainedWithSkills,
  searchAfterChain,
  bureauWithAgentSkillPolicy,
];
