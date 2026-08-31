# The unified typed Agent and Bureau API

Decision record for `AB-15`. This is the compile-ready source of truth for the
final Agent, Bureau, catalog, run, result, error, and event API. Issues
`AB-17`, `AB-18`, `AB-20`, `AB-21`, and `AB-22` implement the contracts
specified here; none of them get to re-litigate a shape this document already
settles.

This document changes documentation only. It does not describe today's
runtime code in `packages/operative` and `packages/bureau` — it describes
where that code is headed. The [Removed surface](#removed-surface) section
names every current API this contract replaces; nowhere else in this
document is a today-only name offered as a supported alternative.

## Agent input and run context

Every entry point that starts a run — `createAgent`'s returned agent,
`createLazyAgent`'s returned agent, and `Bureau.run` — accepts the same input
shape and the same per-run context shape.

```ts
import type { ConversationHistory } from 'conversationalist';

export type AgentInput = string | { conversation: ConversationHistory };

export interface AgentRunContext {
  signal?: AbortSignal;
  traceContext?: unknown;
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
  agentName?: string;
}
```

A bare string starts a fresh conversation. `{ conversation }` resumes from an
existing `ConversationHistory` — the shape a stateless HTTP host holds between
requests — and is snapshotted (cloned) before the run begins, so the run's
state and the caller's object are independent from the moment `run()` is
called.

`agentName` on `AgentRunContext` is for a `RunnableAgent` invoked outside a
named registry (a standalone `createAgent` agent, or a `createLazyAgent` agent
resolved and run directly) that still wants its identity stamped on curated
`tool.*` events. `Bureau.run` fills this from the catalog name automatically —
a caller never needs to pass it there.

## RunnableAgent and the run handle

```ts
export interface RunnableAgent<O = never, H extends boolean = false> {
  readonly name: string;
  run(input: AgentInput, context?: AgentRunContext): AgentRun<O, H>;
}
```

`O` is the agent's validated output type (`never` when the agent has no
`output` schema). `H` ("has output") tracks, at the type level, whether an
`output` schema was supplied at all — it exists so `AgentRun<O, H>` can add or
withhold the `.output()` method without ever exposing a `.output()` that
resolves to `never`.

`run()` is synchronous. It always returns an `AgentRun` immediately — never a
`Promise<AgentRun>` — regardless of whether the agent, its toolbox, or its
generate function were themselves produced lazily (see
[Lazy loading](#lazy-loading)).

### AgentRun

```ts
export type OutputMethod<O, H extends boolean> = [H] extends [true] ? { output(): Promise<O> } : {};

export type UnwrappedValue<O, H extends boolean> = [H] extends [true] ? O : string;

/**
 * Shared by `AgentRun` and (partially) `DiagnosticAgentRun`. `unwrap()`
 * resolves to the run's plain-text `content` for an agent with no output
 * schema, or the schema-validated `O` for one that has one — and rejects if
 * the run's `finishReason` was anything other than a clean stop.
 */
export interface RunOutcomeBase<
  O = never,
  H extends boolean = false,
> extends AsyncIterable<RunEvent> {
  result(): Promise<RunResult<O, H>>;
  unwrap(): Promise<UnwrappedValue<O, H>>;
}

// A type alias, not an `interface extends` — `OutputMethod<O, H>` is a
// conditional type, and TypeScript rejects an interface extending an
// unresolved conditional (`TS2312`). The intersection form has no such
// restriction and is otherwise identical for callers.
export type AgentRun<O = never, H extends boolean = false> = RunOutcomeBase<O, H> &
  OutputMethod<O, H> & {
    abort(reason?: string): void;
    [Symbol.dispose](): void;
  };
```

`AgentRun` is deliberately **not** `Promise`/`PromiseLike`. A thenable handle
is auto-unwrapped at every `async` boundary (`return run`, `Promise.all([run])`,
`Promise.resolve(run)`), which would silently destroy the event stream. The
cost of avoiding that is one explicit method call — `run.result()`,
`run.unwrap()`, or `run.output()` — never a bare `await run`.

`abort` keeps today's operative `abort(reason?: string): void` signature
rather than a bare `abort(): void` — the optional reason is existing,
load-bearing behavior (it is threaded into the abort event and the eventual
error), and nothing in this contract removes it.

```ts
interface RunResultBase {
  conversation: Conversation;
  steps: readonly StepResult[];
  content: string;
  usage: TokenUsage;
  costEstimate?: CostEstimate;
  finishReason: FinishReason;
  error?: unknown;
  schemaValidation?: { success: boolean; error?: unknown };
}

/**
 * The schema-validated success value lives on `output`, present only when
 * `H` is `true` AND `schemaValidation.success` is `true` — this is the ONE
 * public name for a run's validated output; the previous `structuredOutput`
 * field is not exposed anywhere in this API.
 *
 * This is a conditional INTERSECTION, not `output?: […] ? O : never` on a
 * single interface. TypeScript resolves an optional property typed `never`
 * to `undefined`, not to "the property does not exist" — so a single-interface
 * version would let `result().output` be accessed (as `undefined`) even when
 * `H` is `false`, which is not the intended contract. The intersection form
 * below only ADDS the `output` key in the `H = true` branch — accessing
 * `.output` when `H` is `false` (or the un-narrowed `boolean`) is a compile
 * error, not a value typed `undefined`.
 */
export type RunResult<O = never, H extends boolean = false> = RunResultBase &
  ([H] extends [true] ? { output?: O } : {});
```

`run.output()` (present only when `H` is `true`) is the typed convenience path:
it awaits the run and resolves `result().output`, throwing if the run did not
finish cleanly or schema validation failed. `run.unwrap()` is the untyped
convenience path available on every agent: it throws on the same non-success
conditions but resolves the plain-text `content` for an agent with no schema,
or the validated `O` for one that has one — so `unwrap()` is what a caller
reaches for when they don't care whether the agent happens to have a schema,
and `output()` is what they reach for when they specifically want the typed
value and want a compile error if the agent has none.

### DiagnosticAgentRun

A recovered run — one reattached by durable recovery from a checkpoint whose
originating agent definition is no longer resolvable (a renamed or removed
agent, a version mismatch severe enough that the schema can't be trusted) —
cannot promise a caller a validated `O`, because there is no live agent
definition to validate against. `DiagnosticAgentRun` is the handle for exactly
that case.

```ts
export interface DiagnosticAgentRun extends AsyncIterable<RunEvent> {
  result(): Promise<RunResult<unknown, false>>;
  abort(reason?: string): void;
  [Symbol.dispose](): void;
}
```

`DiagnosticAgentRun` deliberately does **not** extend `RunOutcomeBase` — that
base's `unwrap()` is not optional, and a diagnostic run has no principled
value to unwrap into (no schema, no confidently-typed content contract). It
shares `result()`, `abort()`, disposal, and iteration with `AgentRun` by
independent declaration, not by inheritance, so that omitting `unwrap()` and
`output()` is a structural fact about the type, not a runtime check a caller
could route around.

## `createAgent`

```ts
import type { AnyToolbox, HeadlessPermissionPolicyConfiguration, Tool } from 'armorer';
import type { ZodType } from 'zod';

export interface CreateAgentOptions {
  name: string;
  generate: GenerateFunction;
  instructions?: string;
  tools?: Record<string, Tool>;
  toolbox?: AnyToolbox;
  guardrails?: GuardrailsOptions | false;
  skills?: SkillRuntimeConfiguration;
  stopWhen?: StopCondition | StopCondition[];
  maximumSteps?: number;
  executeOptions?: OperativeExecuteOptions;
  retry?: RetryOptions;
  contextManagement?: ContextManagementOptions;
  permissions?: HeadlessPermissionPolicyConfiguration;
  output?: ZodType<unknown>;
}

export function createAgent<O>(
  options: CreateAgentOptions & { output: ZodType<O> },
): RunnableAgent<O, true>;
export function createAgent(
  options: CreateAgentOptions & { output?: undefined },
): RunnableAgent<never, false>;
```

Only a Zod schema is accepted for `output` — this is the single validated
output contract (`AB-18`); there is no separate `responseSchema` /
`responseJsonSchema` pair and no non-Zod Standard Schema branch on this
surface. `name` moves from being optional-and-registry-supplied to a required
field on every agent: `RunnableAgent.name` is populated from it directly, so a
standalone `createAgent` result and a `Bureau`-cataloged one carry their
identity the same way.

`guardrails`, `skills`, `stopWhen`, `maximumSteps`, and (renamed) `instructions`
(formerly `BureauOptions.systemPrompt`) are agent-owned configuration under
this contract — see [Removed from `BureauOptions`](#removed-from-bureauoptions).
An agent that used to inherit these from its bureau now declares them itself;
a bureau with several agents that want the same guardrail policy shares it by
sharing a `GuardrailsOptions` value across each agent's `createAgent({...})`
call, not by bureau-level configuration.

## Lazy loading

Two separate factories cover the two things that can be loaded lazily: the
`generate` function alone, or an entire agent (its instructions, tools, and
output schema together).

### `createLazyGenerate`

```ts
export type GenerateModule = GenerateFunction | { default: GenerateFunction };

export function createLazyGenerate(loader: () => Promise<GenerateModule>): GenerateFunction {
  let resolved: Promise<GenerateFunction> | undefined;

  return async (context) => {
    resolved ??= loader().then((module) =>
      typeof module === 'function' ? module : module.default,
    );
    const generate = await resolved;
    return generate(context);
  };
}
```

`createLazyGenerate` returns a plain `GenerateFunction` — it composes into
`createAgent({ generate: createLazyGenerate(loader) })` exactly like an
eagerly-constructed one. There is nothing to preserve at the type level here:
`GenerateFunction`'s signature is the same whether or not the concrete
provider module has loaded yet.

### `createLazyAgent`

```ts
export type AgentModule<O, H extends boolean> =
  RunnableAgent<O, H> | { default: RunnableAgent<O, H> };

export function createLazyAgent<O, H extends boolean>(
  loader: () => Promise<AgentModule<O, H>>,
): RunnableAgent<O, H> {
  let resolved: Promise<RunnableAgent<O, H>> | undefined;

  const resolve = (): Promise<RunnableAgent<O, H>> =>
    (resolved ??= loader().then((module) => ('run' in module ? module : module.default)));

  return {
    name: '(lazy)',
    run(input, context) {
      return createDeferredAgentRun(resolve().then((agent) => agent.run(input, context)));
    },
  };
}
```

`createLazyAgent`'s return type is `RunnableAgent<O, H>` — the same shape as
an eager `createAgent` result. This is the load-bearing property: a lazy agent
is not a distinct "maybe an agent" type that callers have to unwrap or narrow.
It is a `RunnableAgent`, full stop, so it slots into an `AgentDefinitions` map
(see [`AgentDefinitions`](#agentdefinitions-and-the-agent-catalog)) exactly
like any other entry, and `Bureau.run`'s output-type inference for that name
works identically whether the entry was created with `createAgent` or
`createLazyAgent`.

`run()` still returns synchronously — `createDeferredAgentRun` wraps the
pending `Promise<AgentRun<O, H>>` in a handle that buffers any events that
arrive before the underlying agent resolves, forwards `abort()` and
`[Symbol.dispose]()` to the real run once it exists (or marks the eventual run
pre-aborted if called before resolution), and forwards `result()`/`unwrap()`/
`output()`/iteration once the promise settles.

```ts
declare function createDeferredAgentRun<O, H extends boolean>(
  pending: Promise<AgentRun<O, H>>,
): AgentRun<O, H>;
```

## `AgentDefinitions` and the agent catalog

```ts
export type AgentDefinitions = Record<string, RunnableAgent<any, boolean>>;
```

`AgentDefinitions` is a plain literal object — the map passed as
`BureauOptions.agents`. There is no constructor, no `.register()`/`.unregister()`
lifecycle, and no event stream for registration changes: the map is fixed at
`createBureau(...)` call time. Adding an agent to a running bureau is not a
supported operation; stop the bureau, add the entry to the literal, and
`createBureau` again.

```ts
export interface AgentCatalogEntry<
  D extends AgentDefinitions,
  TName extends keyof D & string = keyof D & string,
> {
  name: TName;
  agent: D[TName];
}

export interface BureauAgentCatalog<D extends AgentDefinitions> {
  get<TName extends keyof D & string>(name: TName): D[TName];
  find(name: string): RunnableAgent<unknown, boolean> | undefined;
  has(name: string): boolean;
  names(): Array<keyof D & string>;
  entries(): Array<AgentCatalogEntry<D>>;
  query(predicate: (entry: AgentCatalogEntry<D>) => boolean): Array<AgentCatalogEntry<D>>;
}
```

`get` is the compile-time-safe lookup — only a literal key of `D` type-checks,
and its return type is that exact entry's `RunnableAgent<O, H>`. `find` is the
runtime lookup for a name that arrived as a plain `string` (an HTTP path
parameter, a webhook payload) — it returns the type-widened
`RunnableAgent<unknown, boolean> | undefined`, since TypeScript cannot narrow a
runtime string back to a literal key. `has`, `names`, `entries`, and `query`
are read-only inspection; none of them mutate the catalog, because the catalog
itself is immutable for the bureau's lifetime.

## Bureau

```ts
export interface BureauOptions<D extends AgentDefinitions> {
  agents: D;

  // Runtime-operation fields — unchanged from today's BureauOptions.
  store?: Store;
  persistence?: PersistenceOptions | StorageConfiguration | ConditionalTextValueStore;
  storage?: StorageConfiguration | Storage;
  durableExecution?: boolean;
  durableBackgroundTasks?: 'automatic' | 'manual';
  memory?: CreateMemoryOptions | Memory;
  cache?: CacheConfiguration;
  identity?: IdentityConfiguration;
  streaming?: StreamingConfiguration;
  scheduler?: SchedulerConfiguration;
  flowControl?: FlowControlPolicy;
  humanInput?: boolean;
  sessionPersistenceRetryDelayMilliseconds?: number;
  sessionPersistenceSleep?: (milliseconds: number) => Promise<void>;
  observability?: boolean | Omit<ObservabilityOptions, 'eventTarget'>;
  onLog?: (record: WorkflowLogRecord) => void;
  durableGuardrails?: DurableGuardrailsConfiguration;
  workflowVersion?: string;
  webhooks?: WebhookNotifierOptions;
  onlineEvals?: OnlineEvalSamplerOptions;
  onDiagnostic?: DiagnosticSink;
}

export declare function createBureau<const D extends AgentDefinitions>(
  options: BureauOptions<D>,
): Promise<Bureau<D>>;
```

`agents` is required — there is no bureau without at least the map itself
(it may be empty, `{}`, for a bureau that only exercises administrative
operations). `createBureau` is the **only** Bureau factory and is **always**
asynchronous: there is no synchronous constructor and no separate two-phase
"construct, then `.ready()`" path. Awaiting `createBureau` is the one and only
initialization boundary in this API — once it resolves, every `Bureau` method,
including `run`, is synchronous or returns its own already-typed promise; none
of them re-enter an "is the bureau ready yet" state.

`const D` on `createBureau` is what makes the literal agent names and their
individual output types survive into `Bureau<D>` — the same "const type
parameter" pattern used elsewhere for literal inference (Zod's own
`z.object({...}).shape`, tRPC's router inference). Passing `agents` through a
variable typed as the widened `AgentDefinitions` (rather than as a literal
object expression) loses this inference, the same way it would for any other
`const`-generic API — see
[Barrel imports](#barrel-imports) for the pattern that keeps it.

### Removed from `BureauOptions`

`generate`, `provider`, `providers`, `routing`, `toolbox`, `guardrails`,
`skills`, `stopWhen`, `maximumSteps`, and `systemPrompt` are gone from
`BureauOptions`. Every one of them is agent-owned configuration now — declared
per agent on `CreateAgentOptions` (`instructions` replaces `systemPrompt`).
There is no bureau-level default `generate`/`provider` an agent falls back to;
every `RunnableAgent` in `agents` supplies its own.

### `BureauRunOptions`

```ts
export interface BureauRunOptions {
  sessionId?: string;
  signal?: AbortSignal;
  traceContext?: unknown;
  withTraceContext?: <T>(parentContext: unknown, fn: () => Promise<T>) => Promise<T>;
  principal?: string;
}
```

There is no per-run agent configuration field here — no `systemPrompt`,
`maximumSteps`, or `maximumTokens` override on the call. Anything that shapes
how the agent runs is fixed on the agent definition; `BureauRunOptions` only
carries session/tracing/attribution concerns that are properties of the
_call_, not the agent.

### `bureau.run`

```ts
export type AgentOutput<D extends AgentDefinitions, TName extends keyof D> =
  D[TName] extends RunnableAgent<infer O, boolean> ? O : never;

export type AgentHasOutput<D extends AgentDefinitions, TName extends keyof D> =
  D[TName] extends RunnableAgent<unknown, infer H> ? H : false;

export interface Bureau<D extends AgentDefinitions = AgentDefinitions> {
  readonly agents: BureauAgentCatalog<D>;

  run<TName extends keyof D & string>(
    name: TName,
    input: AgentInput,
    options?: BureauRunOptions,
  ): AgentRun<AgentOutput<D, TName>, AgentHasOutput<D, TName>>;

  // ...administrative operations, see below.
}
```

`bureau.run(name, input, options?)` preserves the literal `name` you pass and
the corresponding entry's output type — calling `bureau.run('researcher', ...)`
on a bureau whose `researcher` agent was created with `output: z.object({...})`
returns an `AgentRun` whose `.output()` resolves to that exact schema's type,
with no cast anywhere in the call chain. Like `RunnableAgent.run`, this method
is synchronous — it returns the `AgentRun` immediately, never
`Promise<AgentRun>` — regardless of whether the named agent happens to be a
`createLazyAgent` entry still resolving its module.

There is no `createRun` on `Bureau<D>`. `run` replaces it outright; nothing
else in this API creates a run.

### Administrative operations

Everything else `Bureau` exposes today is retained, unchanged in shape, except
for the `run`/`createRun` swap above:

- **Scheduler submission** — `submitSchedulerTask`.
- **Run operations** — `listRuns`, `getRun`, `getRunReport`, `abortRun`, `deleteRun`.
- **Durable-run operations** — `getDurableRun`, `listDurableRuns`, `runDurableMaintenance`.
- **Session operations** — `listSessions`, `getSession`, `deleteSession`, `signalSession`, `updateSession`, `querySession`.
- **Review operations** — `listPendingReviews`, `resolveReview`.
- **Schedule operations** — `createSchedule`, `getSchedule`, `listSchedules`, `pauseSchedule`, `resumeSchedule`, `cancelSchedule`.
- **Configuration and tool operations** — `getConfiguration`, `getTools`.
- **Live-frame operations** — `subscribeLiveFrames`.
- **Event operations** — `addEventListener`, `removeEventListener`, `on`, `once`, `subscribe`, `toObservable`, `events`.
- **Completion and disposal operations** — `complete`, `completed`, `signal`, `dispose`, plus the read-only `store`, `memory`, `scheduler`, `ready`, `sessionStore`, `kv`, `auditTrail`, `webhookNotifier`, and `onlineEvalSampler` properties.

None of these depend on `D` — a `Bureau<D>`'s administrative surface is
identical regardless of which agents were registered, which is why `Bureau`
above is written as `Bureau<D extends AgentDefinitions = AgentDefinitions>`
rather than requiring every consumer of, say, `getRun` to know `D`.

`abortRun`'s _shape_ is unchanged by AB-34, but its _behavior_ is a declared
non-conforming exception to the idempotent-abort rule added in
[Started-work control contract](#started-work-control-contract). It throws
`CONFLICT` against a run that is not currently running instead of returning an
already-terminal outcome. AB-37 owns the remediation; until it lands, the
exception is recorded rather than silently reclassified as conforming.

## Events

```ts
export type RunCompletedEvent<O = never, H extends boolean = false> = {
  result: RunResult<O, H>;
  conversation: Conversation;
  steps: readonly StepResult[];
  content: string;
  usage: TokenUsage;
  finishReason: RunResult['finishReason'];
  output?: O;
};
```

`RunCompletedEvent<O, H>` carries the terminal payload twice on purpose: the
canonical `event.result` object and the existing flattened runtime fields
(`event.conversation`, `event.steps`, `event.content`, `event.usage`,
`event.finishReason`, and, for schema-backed runs, `event.output`). New typed
code should prefer `event.result.output` because it shares the same
`RunResult<O, H>` conditional surface as `run.result()`. Existing event
consumers can keep reading the flattened fields. There is no
`event.structuredOutput` field.

## Started-work control contract

Added by AB-34, amending this document. Every public operation that creates
independently owned asynchronous work returns a live handle or a stable locator
through which an authorized caller can discover, inspect, observe, await, abort,
and confirm cleanup for that work.

This section adds capabilities; it does not reshape anything this document
already specified. `result()`, `unwrap()`, `output()`, `abort()`, and
`[Symbol.dispose]` keep the signatures fixed by AB-15.

### Vocabulary

This ratifies AB-34's own intake clarification as the document's normative text, since that clarification is where the classification actually gets decided:

Lifecycle classification is three independent axes, not one spectrum. **Ownership** is _independently owned_ or _parent-owned_. **Execution mode** is _synchronous inline_ or _asynchronous_. **Durability** is _process-local_ or _durable_. A resource's position on one axis says nothing about its position on another—a _detached_ operation is specifically an asynchronously owned operation with no current observer, which is orthogonal to whether it happens to be durable. Nothing in this codebase requires detachment to imply durability, and nothing requires durability to imply detachment; the two are named separately because they answer different questions (can I currently see it, versus does it outlive this process).

**Independently owned** work supports discover, inspect, observe, await, abort when declared, and cleanup, through its own stable identifier—reachable without going through whatever created it.

**Parent-owned** work is observed through its owner and is not independently abortable unless the owner delegates that capability. It still has its own identity and remains visible in the owner's ownership graph; parent-owned is a visibility and control-surface designation, not an invisibility one.

**Synchronous inline** work is returned directly to its caller and is never reattached—there is no locator for it because there is nothing to reattach to once the call returns.

An **idempotency key** is a caller-supplied opaque string scoped to a principal and an operation kind. Repeating the same canonical request with the same key returns the original receipt. Reusing a key for a materially different request returns a typed conflict, not a silent overwrite or a second start. Idempotency-key retention lasts at least as long as locator retention for the operation it guards.

### Classification table

Every kind of started work named in AB-34's acceptance criteria, classified once:

| Resource                                                              | Ownership                                                  | Identity                                      | Handle or locator                                                                                                                                                                            | Specializing decision                                                                                                                                                                                                                                |
| :-------------------------------------------------------------------- | :--------------------------------------------------------- | :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent run (`createAgent`/`createLazyAgent`/`bureau.run`)              | Independently owned                                        | `runId`                                       | Live `AgentRun`, synchronous, non-thenable; durable projection via `Bureau.getRun(id)`                                                                                                       | This amendment (snapshot/subscribe addition); AB-88 (liveness fields)                                                                                                                                                                                |
| Diagnostic (recovered) run                                            | Independently owned                                        | `runId`                                       | Live `DiagnosticAgentRun`                                                                                                                                                                    | This amendment; AB-88                                                                                                                                                                                                                                |
| Session                                                               | Independently owned                                        | `sessionId`                                   | Live `SessionHandle`; locator via `Bureau.getSession`/`listSessions`                                                                                                                         | Unchanged by this amendment                                                                                                                                                                                                                          |
| Child run (subagent delegation)                                       | Parent-owned by default                                    | `childRunId`, `parentRunId`                   | Discovered through the parent's ownership graph; scoped abort through the parent, not a standalone public locator, unless the owner explicitly returns a live child handle to its own caller | AB-50                                                                                                                                                                                                                                                |
| Managed goal definition                                               | Independently owned                                        | `goalId`                                      | Not yet built                                                                                                                                                                                | AB-101                                                                                                                                                                                                                                               |
| Managed goal attempt                                                  | Independently owned, separate identity from its goal       | `attemptId`, `parentGoalId`                   | Not yet built                                                                                                                                                                                | AB-102                                                                                                                                                                                                                                               |
| Scheduler submission (`submitSchedulerTask`)                          | Independently owned, detached                              | `taskId`                                      | Promise-delivered locator (see [Handles versus locators](#handles-versus-locators))                                                                                                          | Unchanged                                                                                                                                                                                                                                            |
| Recurring schedule definition                                         | Independently owned                                        | `scheduleId`                                  | Locator via `createSchedule`/`getSchedule`/`listSchedules`                                                                                                                                   | AB-41                                                                                                                                                                                                                                                |
| Individual schedule fire                                              | Independently owned, separate identity from its definition | `runId`                                       | An ordinary run (see row 1); the definition holds a reference list, never the reverse                                                                                                        | AB-41                                                                                                                                                                                                                                                |
| Signal wait (parked human input, awaited external signal)             | Parent-owned                                               | none of its own                               | A status value (`waiting`, with a declared-wait reason) on the owning run's snapshot                                                                                                         | AB-41                                                                                                                                                                                                                                                |
| Compaction attempt                                                    | Parent-owned                                               | none of its own                               | Visible through the owning session or run's snapshot and events                                                                                                                              | Not yet filed; see [Not decided](#not-decided)                                                                                                                                                                                                       |
| Evaluation, direct synchronous invocation (as shipped today)          | Synchronous inline                                         | none                                          | Caller holds the batch result directly                                                                                                                                                       | Unchanged                                                                                                                                                                                                                                            |
| Evaluation, asynchronous/background runner (not yet built)            | Independently owned                                        | `evaluationRunId`                             | Same handle/locator family as an agent run                                                                                                                                                   | Not yet filed; see [Not decided](#not-decided)                                                                                                                                                                                                       |
| Long-running tool execution (armorer `ExecutionHandle`)               | Parent-owned, internal to its owning run or toolbox        | `executionId`, `ownerId`, `parentExecutionId` | armorer's existing `ExecutionLifecycle.inspect(selector)`/`abort(selector)` already satisfies the parent-owned control surface; not promoted to a Bureau-visible locator by this amendment   | Settled: stays parent-owned and internal. Promoting it would add public surface with no consumer, against this project's non-goal barring a handle union for every implementation detail. Revisit when a cross-run operator view is actually scoped. |
| Durable background operation (`BureauOptions.durableBackgroundTasks`) | Independently owned, durable                               | shares the durable-run identity family        | `getDurableRun`/`listDurableRuns`, not a distinct resource kind                                                                                                                              | Unchanged                                                                                                                                                                                                                                            |

### The common facts

Every independently owned resource's snapshot satisfies this shape structurally—no resource's concrete type extends it nominally, so armorer, operative, and Bureau keep their own vocabularies for everything beyond this floor:

```ts
export type WorkOwnership = 'independent' | 'parent-owned' | 'inline';
export type WorkDurability = 'process-local' | 'durable';

export interface StartedWorkIdentity {
  readonly id: string;
  readonly kind: string; // e.g. 'agent-run', 'session', 'schedule-fire', 'goal-attempt'
  readonly owner: string; // principal or bureau identifier
  readonly parentId?: string;
  readonly startedAt: string; // ISO timestamp
}

export interface StartedWorkSnapshot<
  TStatus extends string = string,
  TResult = unknown,
> extends StartedWorkIdentity {
  readonly revision: number;
  readonly status: TStatus;
  readonly lastTransitionAt: string; // ISO timestamp
  readonly durability: WorkDurability;
  readonly cancellable: boolean;
  readonly result?: TResult; // present once status is terminal; absent otherwise
}
```

A snapshot is a plain, frozen data value. Reading it never starts work, never blocks, and never mutates state—repeated reads before a represented change return the identical object by reference, which is what lets a caller diff-by-identity instead of deep-comparing. `startedAt` and `lastTransitionAt` are this contract's floor; the richer timestamp and progress fields AB-34's acceptance criteria alludes to (heartbeat, expected-next-observation, and the rest) are AB-88's specialization, not repeated here. `result` is the terminal-result field the acceptance criteria names—for a resource whose result is large or requires its own retrieval path (an `AgentRun`'s full `RunResult`, a `RunReport`), `result` on the snapshot MAY be a reference or summary rather than the full value, with the owning handle's own `result()`/`getRunReport`-style method as the authoritative retrieval path; the snapshot's obligation is only to mark, truthfully, whether a terminal result exists.

### Live-handle additions

Two capabilities are added to `RunOutcomeBase` (and therefore to `AgentRun` and, by the same argument, to any future independently owned live handle). Both are additions—nothing already specified by AB-15 changes shape or signature:

```ts
export interface RunOutcomeBase<
  O = never,
  H extends boolean = false,
> extends AsyncIterable<RunEvent> {
  result(): Promise<RunResult<O, H>>;
  unwrap(): Promise<UnwrappedValue<O, H>>;

  // New in this amendment.
  snapshot(): StartedWorkSnapshot<RunStatus>;
  subscribeSnapshot(listener: (snapshot: StartedWorkSnapshot<RunStatus>) => void): () => void;
  children(): readonly StartedWorkSnapshot[];
}
```

`snapshot()` is the cached, framework-neutral, immutable read the acceptance criteria requires—it is the natural extension point for a Svelte rune, a React hook, or a plain poll loop to project into, without any of them touching `AsyncIterable<RunEvent>`. `subscribeSnapshot()` is a non-consuming _state_ subscription: any number of independent listeners can register against the same run's snapshot at once, and disposing one listener's subscription neither aborts the run nor removes another listener's registration. This is the deliberate answer to the non-goal about observer disposal: disposal ends _that_ observation, never the work. Because `subscribeSnapshot()` delivers the current snapshot synchronously to a newly registered listener before returning its unsubscribe function, a caller who reads a snapshot, then subscribes, cannot miss a transition that happened in between—the first delivered value is always current as of subscription time, closing the read-subscribe-read gap the acceptance criteria calls out by name.

`subscribeSnapshot()` covers state observation only, and does not by itself satisfy "application streaming, telemetry, operator monitoring, and test recording can observe the same work simultaneously" for _event_ fan-out—the iterator stays single-consumption exactly as AB-15 already specifies (`CompletedRunIterationError` on a second consumer is unchanged), and this amendment does not add a multicast event stream to sit alongside it. Multicast event observation is AB-88's specialization: its own acceptance criteria already require exactly this ("`AgentRun` observation is non-consuming: application streaming, telemetry, a watchdog, an operator, and a test recorder can observe one run independently"), and armorer's `ExecutionLifecycle.subscribe(listener)` (execution-lifecycle.ts:120) is existing prior art for a multicast event subscription sitting next to a single-consumption iterator. This amendment's contribution is narrower and structural: whichever mechanism AB-88 lands on, no observer's disposal may consume another observer's stream or abort the work—that invariant is fixed here so AB-88 cannot relitigate it.

`children()` returns parent-owned descriptors—snapshots, not live handles—satisfying "the ownership graph is recursively inspectable from the root" and "runtime-created children remain visible even when they are not returned directly" without promoting any child to an independently owned, Bureau-reachable resource. Scoped cancellation of one child is a distinct method, not an overload of `abort(reason?: string): void` (which AB-15 already shipped and this amendment does not change):

```ts
// New in this amendment, alongside abort(reason?)—not a replacement for it.
abortChild(childId: string, reason?: string): boolean; // idempotent: false if already terminal or unknown
```

`abortChild` is the mechanism behind "abort one child without canceling its sibling" from AB-34's own verification walk. AB-50 owns the concrete implementation; this amendment fixes only the shape and the invariant (targeting one child never propagates to its siblings).

### Handles versus locators

An in-process live start returns a handle synchronously and non-thenably—this already holds for `AgentRun` and is unchanged. A detached or durable start returns a _locator_: a value that names the work (typically its `id`, sometimes wrapped with the fields a caller needs to reattach) and that remains listable, retrievable, and reattachable through the owner named in the identity. A locator is not required to be delivered synchronously—`submitSchedulerTask` and `createSchedule` already return `Promise<{...}>` because a durable submission genuinely has to touch storage before a stable identifier exists, and that is conforming, not an exception. The synchronous, non-thenable requirement binds live handles specifically, because a live handle represents work already running in this process with no persistence step in the way; it does not bind every value this contract calls a locator.

### Abort and cleanup

`abort(reason?: string): void` is idempotent everywhere: calling it once cancellation has already been requested, or after the work is already terminal, has no additional effect and never throws. Today's `AgentRun.abort()` already satisfies this by construction—it forwards to `AbortController.abort()`, which is idempotent on its own terms. `abort()` only _requests_ cancellation; it does not itself report that teardown finished. A separate, always-resolving cleanup acknowledgement reports the outcome honestly:

```ts
export interface CleanupOutcome {
  readonly status: 'completed' | 'failed' | 'timed-out' | 'already-terminal';
  readonly error?: unknown;
}

// Added alongside abort() on every independently owned live handle.
closed(): Promise<CleanupOutcome>;
```

`closed()` never rejects—a failed or timed-out teardown is a resolved value, not a thrown error, so a caller awaiting cleanup always gets an answer instead of having to wrap the call in its own try/catch to find out whether cleanup itself failed.

**Bureau's `abortRun` is a known non-conformance, not a new rule.** `packages/bureau/src/create-bureau.ts:2916` throws `BureauError('Run is already {status}', 'CONFLICT')` when `abortRun(id)` is called against a run that is not currently `'running'`. That is not idempotent—a second `abortRun` call, or a call arriving after the run finished on its own, fails instead of returning an already-terminal outcome. This amendment does not fix it (no runtime code changes here); it records the gap, names `packages/bureau/src/create-bureau.ts:2916-2929` as its exact location, and assigns remediation ownership to AB-37, which owns cancellation and asynchronous shutdown and already covers the durable fencing and cleanup-acknowledgement semantics this fix depends on. Filing it separately now would likely be rewritten once AB-37 settles those semantics. Until that remediation lands, `abortRun` is a **declared exception** to the idempotent-abort rule—the same escape hatch the vault brief's Definition of Done anticipates ("the decision document records intentional exceptions and their owners")—not a silent contradiction.

Armorer's existing `ExecutionHandle.abort(source?, reason?): boolean` (`packages/armorer/src/execution-lifecycle.ts:80`) already conforms: it returns whether _this_ call changed anything, so a repeated call returns `false` rather than throwing. Its `whenSettled(): Promise<ExecutionSnapshot>` (line 83's neighbor) is the closest existing prior art for `closed()` above, and its `ExecutionCleanupOutcome` (`'not-required' | 'completed' | 'failed' | 'unresolved'`, line 26) is the closest existing prior art for `CleanupOutcome`. Settled: adopt armorer's vocabulary where the concepts match exactly — the `revision` field and the shape of the cleanup-outcome enum — but keep this contract's own `snapshot()`, `subscribe()`, and `closed()` method names rather than armorer's `whenSettled()`. `ExecutionHandle` also carries execution-machinery members with no public-API equivalent, so adopting its surface verbatim would couple operative's public API to another package's internal machinery and make any future armorer change a breaking rename here.

Parent-owned children are targetable without becoming independently owned resources: a parent handle exposes both discovery (`children()`, see [Live-handle additions](#live-handle-additions)) and scoped cancellation (`abortChild(childId, reason?)`, narrowing to one child) without any child gaining its own Bureau-reachable locator by default. This is the same selector-based spirit armorer's `ExecutionLifecycle.inspect(selector?)`/`abort(selector?)` already uses at the tool-execution layer—one identifier in, one target affected—and it is how "abort one child without canceling its sibling" (named explicitly in AB-34's verification walk) is satisfiable without contradicting the intake clarification's parent-owned default.

### Durable cancellation

For any operation classified _durable_ above, a cancellation request is recorded—written to durable storage—before the operation is permitted to report success back to the caller who requested it. A stale attempt (one operating against a since-superseded lease or generation) is fenced: its writes after the cancellation was recorded are rejected rather than silently applied. The cancellation state remains observable across a process restart—a caller that reattaches after a crash sees the same cancellation-in-progress or cancellation-complete state a caller that never disconnected would have seen. None of this claims to reverse a side effect a tool, provider, or hook already committed outside the process; where the outcome of such an effect is unknown, the durable record preserves attempt and idempotency evidence instead of asserting a rollback that did not happen. Authoritative durable event observation for any of this is natively blocked by WFT-83, per AB-34's own dependency note—this amendment defines the contract these guarantees must satisfy; it does not claim Weft already satisfies it.

### Detachment

Detachment changes cancellation propagation without erasing causal lineage. A detached operation—independently owned, asynchronous, currently without an observer—keeps its `parentId` and its place in the ownership graph exactly as it had one; what changes is that an `abort()` issued against its former parent no longer implicitly reaches it, because there is no active observer relationship left to propagate through. Reattaching an observer does not change the operation's identity, its accumulated history, or its `parentId`—only its current-observer count.

### Authorization, redaction, retention, and unsupported capabilities

Typed outcomes, not exceptions-as-control-flow, for the cases the acceptance criteria names by name:

Authorization denial is, by default, indistinguishable from not-found: `get`, `list`, `events`, `result`, `children`, `abort`, and `cleanup` all treat a caller with no visibility into a resource the same way they treat a resource that never existed, so that an unauthorized caller cannot use response shape to confirm something exists that they cannot see. A deployment MAY declare a stricter mode that returns a distinct denial outcome instead—that is an explicit, per-deployment opt-in, never the default.

Redaction is a second, separate projection, not a side effect of authorization: `snapshot()`, `subscribe()`'s delivered values, `events`, and `result` each expose a redacted projection to any caller by default, and a privileged, unredacted projection only to a caller whose authorization explicitly grants it. Armorer already ships exactly this split—`ExecutionHandle.snapshot()` versus `ExecutionHandle.privilegedSnapshot()`, and `ExecutionLifecycle.inspect()` versus `inspectPrivileged()` (execution-lifecycle.ts:73, 105, 118)—and this amendment generalizes that split as a requirement for every independently owned resource, not a pattern specific to tool executions: a resource kind that has nothing privileged to redact simply has an identical privileged and redacted projection, but the two accessors still exist so a caller never has to guess which one it received.

Retention expiry returns a typed `expired` locator-resolution outcome, distinct from not-found—the resource existed and the caller may have been authorized to see it, but the evidence has been retired. This is what lets a caller tell "this never existed or you can't see it" apart from "this happened and is now gone."

An unsupported capability is declared, not discovered by failure: every snapshot's `cancellable` field (and any resource-specific durability flag) is set at construction time, and invoking a capability the snapshot declares absent returns a typed `unsupported-capability` outcome rather than a silent no-op or a generic throw.

Subscribing to work that is already terminal is not a missed-transition bug: `subscribe()`'s synchronous first delivery (see [Live-handle additions](#live-handle-additions)) means a terminal-before-subscribe caller receives the terminal snapshot immediately, satisfying "monitor a result without missing it" the same way a not-yet-terminal caller's normal transition delivery does.

Reusing an idempotency key for a request that does not canonically match the original returns a typed conflict outcome, never a silent overwrite and never a second start—this is the vocabulary section's idempotency-key rule restated as a control-flow requirement.

### Test-helper parity

A test helper may supply a deterministic clock, a scripted dependency, or a concise assertion wrapper. It may not expose a lifecycle-control or introspection capability the production surface does not also expose through this same contract—a test build of a handle is a convenience wrapper over the real contract, never a parallel, more-powerful one.

### Compile-ready examples

Three examples, matching AB-34's own acceptance-criteria bullet, added to AB-15's existing `## Compile-ready examples` section:

```ts
// A direct run: snapshot and subscribe alongside the existing result()/unwrap().
const run = bureau.run('researcher', 'Summarize the Q3 report.');
const unsubscribe = run.subscribeSnapshot((snapshot) =>
  console.log(snapshot.status, snapshot.revision),
);
const result = await run.result();
unsubscribe();

// A nested child, discovered through its parent without a standalone locator.
const parentRun = bureau.run('planner', 'Break this project into tasks.');
const firstChild = parentRun.children()[0]; // parent-owned descriptor, not an independent handle
if (firstChild) {
  parentRun.abortChild(firstChild.id, 'no longer needed'); // scoped: this child only, siblings unaffected
}

// A detached durable operation—a schedule fire—reattached and canceled after restart.
const schedule = await bureau.createSchedule({ agentName: 'nightly-report', cron: '0 2 * * *' });
// ...a fire runs, and the process restarts before it finishes. The fire is an ordinary run
// (see the classification table)—its runId is the locator, surfaced by whatever fire-to-
// schedule correlation Bureau's `listRuns`/durable-run surface exposes; the exact accessor
// belongs to AB-41, not this amendment.
declare const reattachedFireRunId: string;
bureau.abortRun(reattachedFireRunId); // synchronous; idempotent once AB-37 lands its remediation
```

## Compile-ready examples

### Direct definitions

```ts
import { z } from 'zod';
import { createAgent } from '@lostgradient/operative';
import { createBureau } from 'bureau';

const researcher = createAgent({
  name: 'researcher',
  generate: myAnthropicGenerate,
  instructions: 'You are a research assistant.',
  output: z.object({ summary: z.string(), sources: z.array(z.string()) }),
});

const writer = createAgent({
  name: 'writer',
  generate: myAnthropicGenerate,
  instructions: 'You draft prose from research notes.',
});

const bureau = await createBureau({
  agents: { researcher, writer },
});

const run = bureau.run('researcher', 'Summarize the Q3 report.');
const summary = await run.output(); // { summary: string; sources: string[] }

const draft = bureau.run('writer', 'Draft an intro from the summary above.');
const text = await draft.unwrap(); // string — `writer` has no output schema
```

### Barrel imports

```ts
// agents/index.ts
export { researcher } from './researcher';
export { writer } from './writer';

// bureau.ts
import * as agents from './agents';
import { createBureau } from 'bureau';

const bureau = await createBureau({ agents });
// bureau.run('researcher', ...) still infers the exact `researcher` output
// type, because `agents` here is the literal namespace object, not a value
// re-typed through a widened `AgentDefinitions` annotation.
```

### Literal dynamic imports

```ts
import { createLazyAgent } from '@lostgradient/operative';
import { createBureau } from 'bureau';

const researcher = createLazyAgent(() =>
  import('./agents/researcher').then((module) => module.researcher),
);

const bureau = await createBureau({ agents: { researcher } });
// The literal specifier './agents/researcher' lets TypeScript resolve the
// module's export type statically, so `researcher` here is exactly
// `RunnableAgent<{ summary: string; sources: string[] }, true>` — the same
// type it would have if imported eagerly.
```

### Lazy loaders

```ts
import { createLazyGenerate, createAgent } from '@lostgradient/operative';

const generate = createLazyGenerate(() =>
  import('./providers/anthropic').then((module) =>
    module.createAnthropicGenerate({ model: 'claude-opus-4-5' }),
  ),
);

const agent = createAgent({
  name: 'researcher',
  generate,
  output: z.object({ summary: z.string() }),
});
// `agent` is `RunnableAgent<{ summary: string }, true>` immediately — the
// provider module (and its API client construction cost) doesn't load until
// the first `agent.run(...)` call actually needs to generate.
```

### Widened runtime modules

```ts
import { createLazyAgent, type RunnableAgent } from '@lostgradient/operative';
import { createBureau } from 'bureau';

// `pluginPath` is resolved at runtime (a config value, a directory scan) —
// TypeScript has no literal specifier to resolve a module type from, so the
// loader is annotated explicitly. `H` is left as the un-narrowed `boolean`
// (not pinned to `true`), because whether the plugin even HAS an output
// schema is exactly what's unknown here, same as the schema's shape.
declare const pluginPath: string;

const plugin = createLazyAgent<unknown, boolean>(
  () => import(pluginPath) as Promise<{ default: RunnableAgent<unknown, boolean> }>,
);

const bureau = await createBureau({ agents: { plugin } });
const run = bureau.run('plugin', 'do the thing');

// `H = boolean` (not the literal `true`) resolves `OutputMethod<unknown, boolean>`
// to `{}` — `run.output()` does not exist on this handle, a compile error, not
// a runtime one. `result().output` doesn't exist either (RunResult's `output`
// key is only added by the `H = true` branch of its conditional intersection)
// — accessing it is a compile error, not a value fabricated as `unknown`.
const text = await run.unwrap(); // string — UnwrappedValue<unknown, boolean> is `string`
```

This is the honest floor for a schema you cannot verify statically:
`unwrap()` always resolves to the model's plain text, and a caller who wants
structure out of it validates the text at the boundary themselves (their own
`JSON.parse` plus their own schema), rather than this API asserting a
compile-time `unknown` it has no basis for.

## Removed surface

The final public API has no:

- `AgentRegistry` or `createAgentRegistry` — superseded by `AgentDefinitions`
  and `BureauAgentCatalog`. There is no register/unregister lifecycle; the
  agent map is fixed at `createBureau` call time.
- `RegistryAgent` — superseded by `RunnableAgent<O, H>`.
- `createBureauRuntime` — superseded by `createBureau`, the sole factory.
- The synchronous `BureauBuilder`/`AgentBuilder` chain (today's
  `.tools()`/`.generate()`/`.agent()`/`.run()` builder) — superseded by the
  plain-literal `AgentDefinitions` passed to `createBureau({ agents })`.
- The `bureau/builder` subpath export.
- The `bureau-types` subpath export in its current form — `AgentBuilder`,
  `AgentConfig`, `AgentTable`, `BureauBuilder`, `NormalizeAgents`, and the
  other builder-chain types it re-exports from operative's
  `bureau-types.ts` no longer exist; this document's `AgentDefinitions`,
  `AgentCatalogEntry`, `AgentOutput`, and `AgentHasOutput` are their
  replacements, exported from the packages' ordinary entry points.

None of the above appear anywhere else in this document as a supported
alternative — every mention above is exactly this removal notice.

## Verification

```sh
bunx prettier --check documentation/operative-type-safe-api.md
bun run --filter @lostgradient/operative check-types
bun run --filter bureau check-types
bun test scripts/documentation-examples.test.ts
```

The two `check-types` commands verify this documentation change didn't touch
runtime code — they are expected to pass unchanged, since this issue's
delivery boundary is decision content only. `AB-17`, `AB-18`, `AB-20`,
`AB-21`, and `AB-22` are where the actual type and runtime changes land,
verified against the contracts fixed here.

The fourth command is AB-34's addition. It checks that every member the examples
above invoke on a run handle is either declared by this document or listed in the
harness as pending with the issue that owns delivery — `snapshot()` and
`subscribeSnapshot()` to AB-88, `children()` and `abortChild()` to AB-50. It
asserts both directions, so a pending entry cannot outlive its implementation and
a new example cannot reference an API nobody owns.

It deliberately does not type-check the fences. They are fragments that never
declare `bureau` or `run`, so none is a standalone module, and the members AB-34
ratifies are not implemented yet by design — a type-check would fail against
today's source and tell you nothing you did not already know. What was actually at
risk is an example drifting from the contract it illustrates, and that is what the
harness catches.
