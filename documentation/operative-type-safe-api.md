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

/**
 * A parent-owned, read-only description of one child (AB-50's Child
 * discovery capability) — enough edge information to reassemble the
 * ownership tree without promoting any child to an independently owned
 * resource. `result` is present once `status` is terminal.
 */
export interface ChildRunDescriptor {
  readonly id: string;
  readonly parentId: string;
  readonly agentName: string;
  readonly durable: boolean;
  readonly status: 'running' | 'completed' | 'failed' | 'aborted';
  readonly result?: RunResult;
}

// A type alias, not an `interface extends` — `OutputMethod<O, H>` is a
// conditional type, and TypeScript rejects an interface extending an
// unresolved conditional (`TS2312`). The intersection form has no such
// restriction and is otherwise identical for callers.
export type AgentRun<O = never, H extends boolean = false> = RunOutcomeBase<O, H> &
  OutputMethod<O, H> & {
    abort(reason?: string): void;
    /** Child discovery (AB-50). Empty when no registry backs this run — never throws. */
    children(): readonly ChildRunDescriptor[];
    /** Scoped child cancellation (AB-50). Idempotent on an unknown or already-terminal id. */
    abortChild(childId: string, reason?: string): void;
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
// AB-34 classifies a recovered run as independently owned, so the required
// capabilities in that amendment apply to it exactly as they do to AgentRun.
// Its deliberate omission of unwrap()/output() is unrelated and stands.
export interface DiagnosticAgentRun extends AsyncIterable<RunEvent> {
  result(): Promise<RunResult<unknown, false>>;
  abort(reason?: string): void;
  children(): readonly ChildRunDescriptor[];
  abortChild(childId: string, reason?: string): void;
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

### Process-local session timing

`SessionHandle.sleep()` and `SessionHandle.monitor()` are host-process conveniences. `sleep()` delays the caller with a local timer, while `monitor()` runs a local loop whose individual `AgentRun` ticks may use the configured durable engine. Supplying a durable engine does not persist either the delay or the monitor controller: process exit loses the outstanding timer and monitor loop.

```ts
export interface MonitorOptions {
  every: number | string;
  input: string;
  until: (result: RunResult) => boolean;
  maxDuration?: number | string;
  signal?: AbortSignal;
}

export interface SessionHandle {
  sleep(duration: number | string, options?: { signal?: AbortSignal }): Promise<void>;
  monitor(options: MonitorOptions): Promise<boolean>;
}
```

Aborting the supplied signal clears the active process-local timer; a monitor also aborts its active tick. The `session.sleep`, `session.monitor.tick`, and `session.monitor.done` events describe only this local activity and make no durable, scheduled, or resumable claim.

Durable behavior uses a distinct run-level capability: a Weft-backed wakeup to park a current run, a durable signal to release a named wait, or a Bureau recurring schedule to start future runs. Session timing never falls back to one of those capabilities implicitly.

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
through which an authorized caller can discover, inspect, observe, await,
_request cancellation of_, and confirm cleanup for that work.

_Request_ is the operative word. A resource whose snapshot declares
`cancellable: false` still exposes the cancellation surface; what it does with a
request is fixed by
[Authorization, redaction, retention, and unsupported capabilities](#authorization-redaction-retention-and-unsupported-capabilities)
— a locator API returns the typed `unsupported-capability` outcome, and a live
handle's `abort()` is an observable no-op. Promising instead that every such
resource _can be aborted_ would contradict that section outright.

This section adds capabilities; it does not reshape anything this document
already specified. `result()`, `unwrap()`, `output()`, `abort()`, and
`[Symbol.dispose]` keep the signatures fixed by AB-15.

### Vocabulary

This ratifies AB-34's own intake clarification as the document's normative text, since that clarification is where the classification actually gets decided:

Lifecycle classification is three independent axes, not one spectrum. **Ownership** is _independently owned_, _parent-owned_, or _inline_ — three values, matching `WorkOwnership` below. _Inline_ means the work has no separate owner at all: it is returned directly to its caller and there is nothing left to own once the call returns. The ownership value is **`inline`**, not "synchronous inline". Synchronous belongs to the execution axis and says nothing about ownership: `runEvaluationSuite` and `runDurableMaintenance` are both `inline` in ownership and _asynchronous_ in execution, because they are `async` functions whose result is nonetheless handed straight back to the caller with nothing left to reattach to. Reading "synchronous" as an ownership property is the confusion this separation exists to prevent. **Execution mode** is _synchronous inline_ or _asynchronous_. **Durability** is _process-local_ or _durable_, and it is determined by **the persistence of the ultimate backing store, transitively** — never by which route the work took or which component is present.

This rule exists because getting it wrong is the most repeated mistake in drafting this table. Using the durable engine does not make work durable: `durableExecution: true` over a memory backend is a supported configuration for local testing, and `BureauOptions` states outright that those checkpoints disappear with the process. Neither does the presence of a store: a `SessionStore` or a `textValueStore` over `MemoryStorage` is a real store whose contents die with the process. Every durability cell below is therefore conditional on the backing store, and an implementer must resolve the chain to the bottom before attaching any restart guarantee. Read a bare "Durable" in this table as "durable when its backing store persists". A resource's position on one axis says nothing about its position on another—a _detached_ operation is specifically an asynchronous operation that no longer has a controlling owner, which is orthogonal to whether it happens to be durable. Detachment is defined by **control ownership alone** — never by whether anyone is currently watching. Nothing in this codebase requires detachment to imply durability, and nothing requires durability to imply detachment; the two are named separately because they answer different questions (who can still cancel this, versus does it outlive this process).

**Independently owned** work supports discover, inspect, observe, await, abort when declared, and cleanup, through its own stable identifier—reachable without going through whatever created it.

**Parent-owned** work is observed through its owner and is not independently abortable unless the owner delegates that capability. It remains visible in the owner's ownership graph; parent-owned is a visibility and control-surface designation, not an invisibility one.

Parent-owned work comes in two forms, and the distinction is load-bearing for anyone implementing it:

- **Addressable** — it has its own identifier and appears in `children()`. A child run is the example. `abortChild(childId)` can target it.
- **Embedded** — it is a _state of its owner_ with no identifier of its own, surfaced through the owner's snapshot rather than as a separate entry. A signal wait and a compaction attempt are the examples: there is no meaningful second thing to address, only a run that is `waiting` or a session that is compacting.

The classification table's Identity column says which form each row takes, so AB-41 and the eventual compaction work do not have to guess whether to mint stable child identifiers. Embedded work is not exempt from observability — it is observable, just through its owner.

**Synchronous inline** work is returned directly to its caller and is never reattached—there is no locator for it because there is nothing to reattach to once the call returns.

An **idempotency key** is a caller-supplied opaque string scoped to a principal and an operation kind. Repeating the same canonical request with the same key returns the original receipt. Reusing a key for a materially different request returns a typed conflict, not a silent overwrite or a second start. Idempotency-key retention lasts at least as long as locator retention for the operation it guards.

**No operative-level start operation accepts an idempotency key**, and this amendment does not add one: `AgentRunContext`, `BureauRunOptions`, and `DurableScheduleDefinition` all lack such a field. What is fixed here is the _semantics_ any key-accepting operation must satisfy, so that whoever introduces the first one cannot invent different rules. Choosing which of those operations take a key, and the request and receipt shapes that carry it, is deliberately out of scope and currently unowned — recorded in [Not decided](#not-decided) rather than implied to exist.

**AB-42 is the first exception.** It fixes the request, receipt, and state-transition shapes for one operative-level start operation, session-input admission (`SessionInputRecord`, `SessionInputReceipt`, `SessionInputState`), while every other start operation remains as described above. Whichever issue implements this contract must add a `## Session input admission` section (placed after Illustrative examples) carrying the type sketches from AB-42's decision record verbatim, including the classification-table row, the widened Session-row scope for AB-50, and the Not decided paragraph, all edited below.

That section already exists below — see [Session input admission](#session-input-admission) — because AB-193 is the issue that implemented this contract's types and applied its amendments.

**AB-67 is the second.** It fixes the request and state-transition shapes for `SteeringCommand` (agent-identity, route, model, provider, effort, pause, and resume changes) while every other start operation still lacks a key. Whichever issue implements this contract must add a `## Steering commands` section (placed after Session input admission) carrying the type sketches from AB-67's decision record verbatim, including the classification-table row and the further-widened Session-row scope for AB-50.

**One shipped path already accepts one and satisfies these semantics within its documented process-local boundary.** The mounted gateway route `POST /hooks/*` scopes an `Idempotency-Key` to the authenticated principal and hook operation, reserves before starting a Bureau run, replays the original successful or known-failure receipt for an identical canonical request, and returns a typed `IDEMPOTENCY_CONFLICT` for a mismatched reuse (`packages/gateway/src/routes/hooks.ts`). Its receipts remain for the lifetime of the route instance, matching the process-local run-locator lifetime; AB-109 owns durable cross-instance receipts.

### The unowned-background-work rule

Fifteen rounds of review on this amendment surfaced the same defect in nine
different components, and enumerating them one at a time was not converging. The
shape is general, so it is stated as a rule rather than rediscovered per row:

**An exported API that starts long-lived or fire-and-forget asynchronous work,
whose stop or dispose path does not await what is already in flight, is a
declared non-conformance against this contract.** An undrained stop path proves
the **cleanup acknowledgement** is missing, and that the work can outlive the
owner that started it.

It does not by itself prove identity or observation are absent, and the rule must
not overwrite a row that records them: background webhook deliveries, one of the
instances below, do carry a delivery-record id discoverable through
`listDeliveries()`. Those two are assessed per path, and where a row classifies
them the row governs.

The remediation splits, because the gap has two halves and closing one does not close the other: **AB-37 owns the awaitable shutdown**, and **AB-88 owns identity and the observation surface** wherever a row records either as absent. Assigning the whole class to AB-37 alone would let it add a drain, close its issue, and leave the work still undiscoverable with nobody responsible for finishing the contract.

Known instances at the time of writing, verified against source: background judge
evaluations, webhook deliveries, audit-trail persistence, the heartbeat loop,
scheduler lifecycle callbacks (`onComplete`, `onPreempted`), the chunked-task
orchestration loop and its callbacks, the file-synchronizer polling loop
(`file-synchronizer.ts:180-212`), and the gateway server lifecycle, whose Bun
adapter discards the promise from `server.stop()` (`adapters/bun-adapter.ts:131-151`).

`Scheduler.stop()` is the one _implementation_ that conforms, and is worth
reading as the reference: it provides an awaitable shutdown path. The rest do
not — and neither does every caller of it. `Bureau.dispose()` hands
`runtime.scheduler.stop()` to `detachBestEffortPromise`
(`create-bureau.ts:3636`) rather than awaiting it, so a Bureau can close its
store, memory, and audit trail while scheduler work is still settling. **The
rule is about the stop path a caller actually takes, not the primitive it
calls**: a conforming shutdown used in a non-conforming way is still an
instance of it.

**This list is not exhaustive and does not claim to be.** It covers what review
found across `operative`, `bureau`, `gateway`, and `skills`; other packages have
not been swept. Completing the inventory is tracked as AB-182 — a contract that
silently implied full coverage would be making exactly the claim this rule exists
to stop it making.

### Classification table

Every kind of started work named in AB-34's acceptance criteria, classified once, plus the shipped paths review has since added. **The table is exhaustive against AB-34's named resources and best-effort beyond them**: anything matching [the unowned-background-work rule](#the-unowned-background-work-rule) is covered by that rule whether or not it has a row here.

| Resource                                                                              | Ownership                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Execution mode                                                                                                                                                                                                                                                                               | Durability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Identity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Handle or locator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Specializing decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| :------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent run (`createAgent`/`createLazyAgent`/`bureau.run`)                              | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | Process-local, unless started through a durable route **and** that engine's checkpoint store persists. `durableExecution: true` over a memory backend still uses the durable engine, and its checkpoints do not survive the process.                                                                                                                                                                                                                                                                                      | `runId` **when the Bureau starts it**, which registers the run in the `Store` where `getRun`/`getDurableRun` resolve it. **Declared gap on the standalone path:** `createAgent(...)`/`createLazyAgent(...).run()` calls `createActiveRun(runOptions)` with no durable routing (`create-agent.ts:420`), so no id is supplied or minted, `AgentRun` exposes none, and there is no store to discover one. **AB-88** owns giving that branch an obtainable identity, as it does for direct construction. | Live `AgentRun`. For durable runs the engine-backed locator is `Bureau.getDurableRun(id)` (`create-bureau.ts:2999`), **not** `Bureau.getRun(id)`, which reads only the process-local `Store` (`create-bureau.ts:2894`). **Two declared non-conformances after a restart:** the retained-result gap between those two locators, and — when `classifyRecoveredRun` takes the `skip` branch because session metadata could not be read (`create-bureau.ts:556-559`) — the workflow may resume with no live `getRun` visibility, so `abortRun` returns `NOT_FOUND` and `getDurableRun` is read-only. An ordinary durable run is then observable but not cancellable, exactly as a recovered schedule fire is. The live handle also carries none of the capabilities [Required capabilities](#required-capabilities) fixes: **no cached snapshot, no state observation, no child discovery, no scoped child cancellation, and no cleanup acknowledgement** — the placeholders the verification harness tracks. **AB-88** owns the snapshot and observation, **AB-50** child discovery and scoped child cancellation, **AB-37** the cleanup acknowledgement. | AB-88 for the retained-result gap; **AB-37 for engine-backed cancellation**, which this row and the schedule-fire row both now need; **AB-50** for child discovery and scoped child cancellation                                                                                                                                                                                                                                                                                                                                                                                                 |
| Direct run construction (`createActiveRun`)                                           | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | From the durable routing argument **and its backing store's persistence**, per the transitive rule above; process-local otherwise                                                                                                                                                                                                                                                                                                                                                                                         | **Split by route.** With durable routing the caller supplies `DurableRunRouting.runId` (`create-run.ts:291-293`), which is required and is itself the durable workflow resume key — so a stable identity exists and the engine the caller passed can address that workflow. Without it, **none**: the in-memory branch mints nothing. Either way `ActiveRun` (`create-run.ts:33-67`) exposes no id, so even a durable caller can only use the one it already held.                                   | **Declared non-conformance.** An exported, documented factory (`create-run.ts:69-90`) that starts work directly, whose handle exposes no identifier — not even the one a durable caller supplied — no cached snapshot, no state observation, no child discovery, no scoped child cancellation, and no cleanup acknowledgement. On the in-memory branch a direct consumer therefore creates independently owned work that no locator can reach, the starkest gap in this table; on the durable branch it can reach the workflow only through the id it is already holding, never through the handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **AB-88** for identity and the observation surface, and it must decide whether `ActiveRun` gains identity or direct construction is documented as outside the contract; **AB-50** for child discovery; **AB-37** for the cleanup acknowledgement. Naming only AB-88 would let it close while two thirds of this row's declared non-conformance stayed unowned.                                                                                                                                                                                                                                   |
| Diagnostic run (`createDiagnosticAgentRun`)                                           | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | **Undeterminable from the wrapper.** `createDiagnosticAgentRun(activeRun)` (`agent-run.ts:389`) is publicly exported, accepts any `ActiveRun`, and performs no origin check — and the public `ActiveRun` surface (`create-run.ts:33-67`) carries no durable-route or backing-store metadata, so neither the wrapper nor AB-88 can recover the wrapped run's durability from it. A declared non-conformance: the classification exists but nothing can evaluate it.                                                        | **Declared gap.** Neither `ActiveRun` (`create-run.ts:33-67`) nor `DiagnosticAgentRun` (`agent-run.ts:100-104`) exposes a `runId`, and the factory accepts an arbitrary `ActiveRun` without minting one, so a direct caller cannot obtain the identity this row previously presented as satisfied.                                                                                                                                                                                                   | Live `DiagnosticAgentRun` The live handle also carries none of the capabilities [Required capabilities](#required-capabilities) fixes: **no cached snapshot, no state observation, no child discovery, no scoped child cancellation, and no cleanup acknowledgement** — the placeholders the verification harness tracks. **AB-88** owns the snapshot and observation, **AB-50** child discovery and scoped child cancellation, **AB-37** the cleanup acknowledgement. `DiagnosticAgentRun` declares only iteration, `result`, `abort`, and disposal (`agent-run.ts:99-104`), so every one of them is absent by declaration rather than by oversight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | This amendment; **AB-88 must either carry the resolved persistence classification onto `ActiveRun`, or constrain diagnostic construction to a source whose durability is known.** Deriving it from the wrapper is not currently possible. **AB-88 also owns adding an obtainable identity**, as it does for direct construction. **AB-50** owns child discovery and scoped child cancellation here, and **AB-37** the cleanup acknowledgement; AB-88 closing alone would leave this exported handle short of the contract.                                                                       |
| Session                                                                               | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | Durable **only when the session store's backing storage is persistent**. A `SessionStore` over `MemoryStorage` is process-local: `BureauOptions` documents that memory storage loses checkpoints with the process, and the repository composes valid session stores over it extensively.                                                                                                                                                                                                                                  | `sessionId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **Declared non-conformance.** `Bureau.getSession`/`listSessions` give discovery, but the shipped `SessionHandle` (`packages/operative/src/session/session-handle.ts:107`) has no cached snapshot, no state observation, no terminal result, no child discovery over the runs it owns, no scoped child cancellation, and no cleanup acknowledgement. A session cannot today satisfy the inspect, observe, await, and cleanup guarantees this contract requires of independently owned work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | AB-88 owns extending the observation surface to sessions, and must not promise reattachment a memory-backed store cannot provide; **AB-37 owns the cleanup acknowledgement**, which [Required capabilities](#required-capabilities) assigns to it. Folding cleanup into the observation owner would leave part of this row's declared non-conformance unowned once AB-88 lands; **AB-50** owns child discovery and scoped child cancellation over the runs, session-input records, and steering commands a session owns (session input added by **AB-42**, steering commands added by **AB-67**) |
| Child run (subagent delegation)                                                       | Parent-owned by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Asynchronous                                                                                                                                                                                                                                                                                 | **Caller-declared, not derived — `dispatchChildRun` (AB-50) always dispatches through `RunnableAgent.run()`, the in-process route, so every child it issues is process-local.** A caller wiring a durable child through a durable-aware `RunnableAgent` is responsible for passing `durable: true` to `dispatchChildRun`/`createSubagentTool`'s `parentContext.durable` to match; neither can verify the route itself.                                                                                                    | `childRunId`, `parentRunId` (and, via `ChildRunDescriptor.parentId`, the edge one registry needs to reassemble the FULL ownership tree from a flat `children()` list at arbitrary depth)                                                                                                                                                                                                                                                                                                             | **Shipped by AB-50.** Discovered through the parent's `AgentRun.children()`/`.abortChild()` — opt-in: a caller supplies one `ChildRunRegistry` (`createChildRunRegistry()`) to both `createAgentRun`'s `childRegistry` option and every `createSubagentTool` this run dispatches through (`parentContext.registry`); omitted, both read as the safe empty/no-op default rather than throwing. A caller may also retain the `ChildRunHandle` `dispatchChildRun` returns directly, independent of any registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **AB-50**, which closes the derive-or-constrain obligation by declaring the route rather than inferring it: `dispatchChildRun` always takes the in-process `RunnableAgent.run()` path and has no way to introspect an arbitrary `RunnableAgent`'s actual backing store, so durability stays a caller-declared flag (`durable`) rather than something the primitive derives — see the Durability column.                                                                                                                                                                                          |
| Managed goal definition                                                               | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | Intended durable, and therefore conditional on its backing store persisting once built — the same transitive rule every shipped row follows                                                                                                                                                                                                                                                                                                                                                                               | `goalId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Not yet built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | AB-101                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Managed goal attempt                                                                  | Independently owned, separate identity from its goal                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Asynchronous                                                                                                                                                                                                                                                                                 | Intended durable, and therefore conditional on its backing store persisting once built — the same transitive rule every shipped row follows                                                                                                                                                                                                                                                                                                                                                                               | `attemptId`, `parentGoalId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Not yet built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | AB-102                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Gateway hook run with an idempotency key (`POST /hooks/*`)                            | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | **Process-local receipt state.** The route-local receipt map survives for the route instance lifetime, at least as long as the process-local run locator it guards. Neither receipts nor locators survive a restart or coordinate across gateway instances; AB-109 owns that durable boundary.                                                                                                                                                                                                                            | The caller's `Idempotency-Key`, scoped to the authenticated principal and `hooks:create-run` operation, plus the `runId` on a successful returned summary                                                                                                                                                                                                                                                                                                                                            | The first request reserves a promise before starting the run, so concurrent identical requests share one start. An identical retry receives the original status and body, including known failures; a materially different canonical request receives typed `IDEMPOTENCY_CONFLICT`. The gateway rate limiter charges the first admitted hook request while serializing its route handling; it bypasses a later request only when the shared hook registry already contains a replayable receipt for that principal, operation, and key. Malformed requests never create such an entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Conforming within the documented process-local boundary. **AB-109** owns durable cross-instance receipt storage and is natively blocked by AB-185 until this local contract lands.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Scheduler submission (`submitSchedulerTask`)                                          | **Parent-owned** by the scheduler that runs it, and through it by the Bureau — not detached. `create-scheduler.ts` names the scheduler as the task's single lifecycle owner; `Scheduler.stop()` aborts active background tasks and discards queued ones, and Bureau disposal invokes that stop path. A Bureau shutdown therefore still propagates control to a submitted task, which is the definition of an owner this contract uses.                                                                               | Asynchronous                                                                                                                                                                                                                                                                                 | Process-local — Bureau's in-process flow-control queue, not Weft-backed                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `taskId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Declared non-conformance.** The receipt carries `taskId`, but `create-bureau.ts:2869` discards the scheduler's result promise and the public `Scheduler` surface exposes only transient `getState()` and `cancel()`. Once a task leaves the active or queued state its result cannot be retrieved, awaited, or its cleanup confirmed by that id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **AB-180** owns making a settled task's result retrievable by its `taskId`; **AB-37** owns the cleanup acknowledgement this row records as unconfirmable through that id.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Recurring schedule definition                                                         | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | A native Weft schedule, durable **only when the engine's checkpoint store persists**                                                                                                                                                                                                                                                                                                                                                                                                                                      | `scheduleId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Declared non-conformance, three creation paths.** `Bureau.createSchedule` yields `null` when a schedule registers but its summary cannot be retrieved, leaving work with no locator. The exported `createAgentSchedule` / `createAgentScheduler().schedule` return an `AgentScheduleHandle` with only `id`, `pause`, `resume`, `cancel`, `describe`. The exported `createDurableHeartbeat` (`scheduler/create-durable-heartbeat.ts:114-173`) creates or reuses a schedule and returns a `DurableHeartbeat` with `id`, pause/resume/cancel/update/describe, whose disposal merely unregisters services. None carries the required snapshot, observation, or cleanup-acknowledgement capabilities.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **AB-41** for all three creation paths: fixing only the Bureau method leaves two public paths outside the contract. **AB-88** for the cached snapshot and state observation, and **AB-37** for the cleanup acknowledgement — the handles still lack all three once creation is fixed.                                                                                                                                                                                                                                                                                                            |
| Individual schedule fire                                                              | Independently owned, separate identity from its definition                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Asynchronous                                                                                                                                                                                                                                                                                 | Durable on the same condition as its definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `runId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | An ordinary run (see row 1). The definition holds a reference list, and a fire-to-schedule marker does exist in the other direction — Weft 0.10+ writes `KEYS.scheduleRun(runId)`, and `loadScheduleIdForRecoveredRun` reads it during recovery (`runtime-composition.ts:1863-1874`). It is internal, and resolving it needs a run id the caller already holds, so it gives no schedule-to-fire discovery and no public accessor in either direction. **Declared non-conformance after a restart:** recovery routes a native fire down the `monitor` path and does not register an `ActiveRun` (`create-bureau.ts:545-551`), so `abortRun` throws `NOT_FOUND` (`create-bureau.ts:2916-2920`) and no engine-backed per-run cancellation exists — `cancelSchedule` cancels the definition, not the fire. A recovered fire is therefore observable but not cancellable.                                                                                                                                                                                                                                                                                   | AB-41 for the fire-to-schedule accessor; **AB-37 for engine-backed cancellation of a recovered run**, which is the guarantee a restart is supposed to preserve                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Session input (conversational admission, `steer`/`queue`)                             | Parent-owned, addressable; its own `id`, appears in the owning session's ownership graph                                                                                                                                                                                                                                                                                                                                                                                                                             | Asynchronous                                                                                                                                                                                                                                                                                 | Inherits the owning session's durability, per the transitive rule                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `id`, `sessionId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | No standalone live handle. Discovered through the owning session's ownership graph (AB-50) and observed through `SessionInputSnapshot` (AB-88); admission returns a `SessionInputReceipt`, not a handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | AB-42 fixes the record/receipt/state shapes and the promotion boundary; AB-88 owns the snapshot/observation signature; AB-50 owns child discovery through the session; runtime persistence is WFT-84                                                                                                                                                                                                                                                                                                                                                                                             |
| Steering command (agent-identity, route, model, provider, effort, pause, resume)      | Parent-owned, addressable; its own `id`, appears in the owning session's ownership graph                                                                                                                                                                                                                                                                                                                                                                                                                             | Asynchronous                                                                                                                                                                                                                                                                                 | Inherits the owning session's durability, per the transitive rule                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `id`, `sessionId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | No standalone live handle. Discovered through the owning session's ownership graph (AB-50) and observed through the session's snapshot surface (AB-88); admission returns a synchronous accept/reject outcome, not a handle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | AB-67 fixes the command/state shapes and the application boundary; AB-66 owns the selector a `policyRef` resolves through; AB-88 owns the snapshot/observation signature; AB-50 owns child discovery; runtime persistence is WFT-84                                                                                                                                                                                                                                                                                                                                                              |
| Durable timer wait (`scheduleWakeup`)                                                 | Parent-owned, embedded — a state of the run, with no identity of its own                                                                                                                                                                                                                                                                                                                                                                                                                                             | Asynchronous                                                                                                                                                                                                                                                                                 | The owning run's durability: the wait is a real `ctx.sleep` inside the workflow (`run-workflow.ts:733-735`), so it survives a restart exactly as far as its run does                                                                                                                                                                                                                                                                                                                                                      | none of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A status on the owning run's snapshot, with the wakeup time as its declared-wait reason. Distinct from a recurring schedule, which is independently owned, and from a signal wait, which resolves on an external event rather than a deadline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **AB-88**, which must expose a sleeping run's wakeup state and reason, not only human-input waits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Signal wait (parked human input, awaited external signal)                             | Parent-owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Asynchronous                                                                                                                                                                                                                                                                                 | Inherits the owning run's durability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | none of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A status value (`waiting`, with a declared-wait reason) on the owning run's snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | AB-41                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Session sleep (`SessionHandle.sleep`)                                                 | Inline — the caller awaits it and there is nothing to reattach to                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Asynchronous                                                                                                                                                                                                                                                                                 | **Process-local, always.** The implementation awaits an in-process `setTimeout` (`session-handle.ts:1058-1076`) and never consults the engine even when one is attached, so it is not the durable `scheduleWakeup` state and must not inherit its guarantees.                                                                                                                                                                                                                                                             | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | No locator: the wait is not observable and does not survive a restart. Its public JSDoc claims a durable pause requiring a durable engine, which the implementation does not deliver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **AB-40**, which owns making the process-local nature explicit in the JSDoc and event names                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Session monitor loop (`SessionHandle.monitor`)                                        | Inline — the returned `Promise<boolean>` is handed to its caller and there is nothing left to reattach to                                                                                                                                                                                                                                                                                                                                                                                                            | Asynchronous, potentially long-lived: it repeatedly starts runs and sleeps until a predicate or deadline is met (`session-handle.ts:1183-1247`)                                                                                                                                              | **Process-local**, even when its session and the runs it starts are durable. The loop is a `setTimeout` in this process, exactly as `sleep` is.                                                                                                                                                                                                                                                                                                                                                                           | none of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The runs it starts are classified in their own row; that says nothing about the loop. A caller holding the promise cannot ask whether the loop is sleeping, running an iteration, or how many remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **AB-40** owns making the process-local nature explicit, alongside `sleep`. Observation is **not** owed here, and that is a decision rather than an open question: this row is classified inline, and the contract's inspect-and-observe guarantees bind independently owned work. An issue that later makes the loop independently owned reclassifies this row and inherits AB-88's observation obligation with it.                                                                                                                                                                             |
| Compaction attempt                                                                    | Parent-owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Asynchronous                                                                                                                                                                                                                                                                                 | Inherits its owning session or run, and therefore that owner's backing store: a compaction on a memory-backed session is process-local like everything else the session holds. Per the transitive rule, never asserted independently.                                                                                                                                                                                                                                                                                     | none of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Visible through the owning session or run's snapshot and events                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Not yet filed; see [Not decided](#not-decided)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Evaluation entry points (`runEvaluationSuite` and `createAgentEvaluation(...).run()`) | Inline — the result is returned directly to its caller and never reattached                                                                                                                                                                                                                                                                                                                                                                                                                                          | Asynchronous — both are `async`; `runEvaluationSuite` (`run-evaluation-suite.ts:126`) merely constructs the runner and delegates to `createAgentEvaluation(...).run()` (`create-agent-evaluation.ts:298-327`), which is itself publicly exported and is where case execution actually starts | Process-local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Caller holds the awaited result directly; there is no locator because there is nothing to reattach to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Unchanged. Both entry points are named because the package exports both, and the direct runner is the one that starts the work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Background judge evaluation (`online-evals`, as shipped today)                        | Independently owned, **detached from launch.** No controlling owner exists at any point: `OnlineEvalSampler` exposes only counters, `flush()`, and `dispose()`, and `evaluateRun()` invokes each judge with no `AbortSignal`, so a live Bureau cannot cancel one either. Under this contract's control-based definition — who can still cancel the work — that is detachment from the moment it starts, not a transition that happens at disposal. Disposal is not the ownership gap, only its most visible symptom. | Asynchronous                                                                                                                                                                                                                                                                                 | Process-local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | none of its own — tracked in an in-memory `activeEvaluations` set (`online-evals.ts:175`)                                                                                                                                                                                                                                                                                                                                                                                                            | **Declared non-conformance.** `flush()` drains what is in flight, but no caller can discover, inspect, await, or cancel one evaluation, and `dispose()` (`online-evals.ts:257-260`) orphans any still running.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | AB-88 for the observable surface; **AB-37 for Bureau-owned cancellation**, which is what would make this parent-owned rather than detached                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Evaluation, independently owned background runner (not built)                         | Independently owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | Undecided until it exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `evaluationRunId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Same handle/locator family as an agent run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Not yet filed; see [Not decided](#not-decided)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Long-running tool execution (armorer `ExecutionHandle`)                               | Parent-owned, internal to its owning run or toolbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | Process-local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `executionId`, `ownerId`, `parentExecutionId`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **Split.** When the caller supplies a toolbox, armorer's `ExecutionLifecycle.inspect(selector)`/`abort(selector)` satisfies the parent-owned control surface. When an agent is configured with `tools` instead, `createAgent` builds a toolbox inside `run()` and the returned `AgentRun` exposes neither it nor its `executions` lifecycle, and bubbled run events omit `executionId` — so those executions are **unreachable through their public owner**, contradicting the root-to-arbitrary-depth ownership requirement. A declared non-conformance for that path only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Not promoted to a Bureau-visible locator by this amendment. **AB-50 owns exposing internally-created executions through their run**, since it already owns child discovery and delegated control.                                                                                                                                                                                                                                                                                                                                                                                                |
| Background webhook delivery (`Bureau.webhookNotifier`)                                | Independently owned, **detached from launch.** No controlling owner exists at any point: `WebhookNotifier` exposes only list, flush, notify, and dispose, and `deliver()` passes no abort signal to `fetchImpl`, so a live Bureau cannot cancel a delivery. Under this contract's control-based definition — who can still cancel the work — that is detachment from the moment it starts, not a transition that happens at disposal.                                                                                | Asynchronous — `notify()` launches tracked `deliver()` promises (`webhook-notifier.ts:128`)                                                                                                                                                                                                  | **The record and the work differ, and only the record can be durable.** The _record_ persists when the KV backend persists; without `runtime.kv`, `persist()` returns early (`:278`), and over `MemoryStorage` it dies with the process. The _delivery work_ is always process-local: startup never scans pending records and `deliver()` returns immediately when the key exists (`:312-315`), so a process exiting after persisting `status: 'pending'` leaves a durable record for work that never resumes or retries. | Delivery record id via `listDeliveries()`, for as long as the backend retains it                                                                                                                                                                                                                                                                                                                                                                                                                     | **Inspection already ships and is not the gap.** `listDeliveries()` returns each persisted `WebhookDeliveryRecord` — id, status, attempts, timestamps, last error (`webhook-notifier.ts:88-101`, `:451-465`) — so a caller with a KV store can inspect an individual delivery today, and `flush()` awaits everything in flight. **Declared non-conformance, three ways**, all narrower than that: there is no non-consuming state observation of a delivery; no way to await or cancel _one_ delivery, since `flush()` is all-or-nothing and `deliver()` passes no abort signal to `fetchImpl`; and no per-delivery cleanup acknowledgement, so a persisted `pending` record can permanently outlive its stopped work.                                                                                                                                                                                                                                                                                                                                                                                                                                 | AB-88 for the observable surface and for gating restart guarantees on the backend; **AB-37 for cancellation and awaitable shutdown**                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Audit-trail persistence (`Bureau.auditTrail`)                                         | Independently owned, **detached from launch.** The action listener launches `kv.set(...)` without awaiting or tracking the promise, and `dispose()` only removes the listener — nothing can await or cancel an in-flight write.                                                                                                                                                                                                                                                                                      | Asynchronous, fire-and-forget                                                                                                                                                                                                                                                                | The written record follows the KV backend; the write itself is process-local                                                                                                                                                                                                                                                                                                                                                                                                                                              | none — the promise is never retained                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **Declared non-conformance.** An in-flight audit write has no identity, no inspection, and no cleanup acknowledgement, and can continue after Bureau disposal while backend teardown proceeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **AB-37** for the drain-or-cancel behaviour; **AB-88** for the identity and state observation this row records as absent. Not conditional on whether these writes _should_ be inspectable: the unowned-background-work rule assigns that half to AB-88 for every path it covers, and audit persistence is one of its named instances.                                                                                                                                                                                                                                                            |
| Scheduler lifecycle callback (`onComplete`, `onPreempted`)                            | Independently owned, **detached from launch.** The scheduler invokes them with `void` and neither retains nor awaits the returned promise (`create-scheduler.ts:562`, `:604`, `:760`), so an asynchronous callback can continue or reject after its task receipt settles and after the scheduler itself is stopped.                                                                                                                                                                                                  | Asynchronous                                                                                                                                                                                                                                                                                 | Process-local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | none of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Declared non-conformance.** Nothing observes, awaits, or cancels these; a rejection after the owner has stopped has nowhere to surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | **AB-37** for draining them at shutdown, alongside the other fire-and-forget paths; **AB-88** for the identity and observation surface this row records as absent. That split is what [the unowned-background-work rule](#the-unowned-background-work-rule) requires: a drain alone still leaves a callback nothing can find, name, or await on its own                                                                                                                                                                                                                                          |
| Scheduler loop (`createScheduler`)                                                    | **Parent-owned by the Bureau when the Bureau starts it; independently owned when constructed directly.** `Scheduler.start()` launches and retains `schedulerLoop()` (`create-scheduler.ts:824-843`), and unlike the other background loops `stop()` does provide an awaitable shutdown path.                                                                                                                                                                                                                         | Asynchronous, long-lived                                                                                                                                                                                                                                                                     | Process-local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | none — a submitted task's `taskId` identifies that task, never the loop running it                                                                                                                                                                                                                                                                                                                                                                                                                   | **Declared non-conformance, two gaps.** The loop has no snapshot and no observation surface, so a caller cannot ask whether it is running, draining, or stalled. And while `Scheduler.stop()` is itself awaitable — more than the heartbeat or notifier offer — `Bureau.dispose()` hands it to `detachBestEffortPromise` (`create-bureau.ts:3636`) instead of awaiting it, so a Bureau-owned loop can still be settling while the store and memory it depends on are being closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | AB-88 for the observation surface; **AB-37 for the Bureau dispose path**, which detaches `Scheduler.stop()` rather than awaiting it. The primitive conforms; the Bureau's use of it does not, and only the second is still open                                                                                                                                                                                                                                                                                                                                                                  |
| Heartbeat loop (`createHeartbeat`)                                                    | Independently owned, **detached from launch.** `start()` launches a fire-and-forget asynchronous loop and `stop()` flips a flag and returns without awaiting an in-flight `tick()` or async `onTick`.                                                                                                                                                                                                                                                                                                                | Asynchronous, long-lived                                                                                                                                                                                                                                                                     | Process-local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | none of its own — individual ticks are scheduler submissions, which does not give the loop an identity                                                                                                                                                                                                                                                                                                                                                                                               | **Declared non-conformance.** The long-lived loop itself has no discovery, no observation, and no awaitable shutdown; classifying its ticks does not cover it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **AB-37** owns the awaitable shutdown; **AB-88** owns the identity and state observation this row records as absent, which a drain alone does not supply.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Durable maintenance invocation (`runDurableMaintenance`)                              | Inline — the host calls it and holds the outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Asynchronous                                                                                                                                                                                                                                                                                 | Drives durable work; is not itself durable work                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Caller awaits the invocation directly; there is no locator because there is nothing to reattach to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Unchanged. `BureauOptions.durableBackgroundTasks` (`'automatic' \| 'manual'`, `packages/bureau/src/types.ts:307`) is a **configuration switch** selecting whether Bureau drives maintenance on a process-local interval or the host calls it, not a started-work resource: it has no durable-run identity and cannot be retrieved by `getDurableRun`/`listDurableRuns`. The durable workflows it advances are classified in the agent-run and schedule-fire rows above.                                                                                                                          |

Ownership, execution mode, and durability are independent axes, so every row is
classified on each rather than folding them into one column. `inline` is an ownership value only, never an execution guarantee. An inline operation may still be asynchronous, and both inline rows above are: `runEvaluationSuite` and `runDurableMaintenance` are `async` functions whose results are handed straight back with nothing left to reattach to. Read the two columns independently rather than assuming they agree. A durability entry
reading "inherits" means the resource has no durability of its own; it is
whatever its owner is.

### The common facts

Every independently owned resource's snapshot satisfies this shape structurally—no resource's concrete type extends it nominally, so armorer, operative, and Bureau keep their own vocabularies for everything beyond this floor:

```ts
export type WorkOwnership = 'independent' | 'parent-owned' | 'inline';
export type WorkDurability = 'process-local' | 'durable';

export interface StartedWorkIdentity {
  readonly id: string;
  readonly kind: string; // e.g. 'agent-run', 'session', 'schedule-fire', 'goal-attempt'
  /**
   * Principal or bureau identifier. Absent for a standalone `RunnableAgent.run`,
   * which has neither: `AgentRunContext` carries no principal and no Bureau
   * issued the handle. Optional rather than required so no implementer has to
   * fabricate a value to satisfy this floor — an absent owner is a truthful
   * statement that the work has no authorization context, not missing data.
   */
  readonly owner?: string;
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
  /**
   * Which projection this snapshot is. Required because the authorization
   * section says a caller must read the projection in force rather than guess
   * it — without a discriminator here, a privileged and a redacted snapshot
   * are indistinguishable and that requirement is unsatisfiable.
   */
  readonly projection: 'redacted' | 'privileged';
  readonly ownership: WorkOwnership;
  /**
   * True once the work has no controlling owner. Detachment is an explicit
   * transition (see Detachment), so it is recorded here rather than inferred
   * from observer count or from `ownership` alone.
   */
  readonly detached: boolean;
  readonly durability: WorkDurability;
  readonly cancellable: boolean;
  readonly result?: TResult; // present once status is terminal; absent otherwise
}
```

A snapshot is a plain, frozen data value. Reading it never starts work, never blocks, and never mutates state—repeated reads before a represented change return the identical object by reference, which is what lets a caller diff-by-identity instead of deep-comparing. `startedAt` and `lastTransitionAt` are this contract's floor; the richer timestamp and progress fields AB-34's acceptance criteria alludes to (heartbeat, expected-next-observation, and the rest) are AB-88's specialization, not repeated here. `result` is the terminal-result field the acceptance criteria names—for a resource whose result is large or requires its own retrieval path (an `AgentRun`'s full `RunResult`, a `RunReport`), `result` on the snapshot MAY be a reference or summary rather than the full value, with the owning handle's own `result()`/`getRunReport`-style method as the authoritative retrieval path; the snapshot's obligation is only to mark, truthfully, whether a terminal result exists.

### Required capabilities

This contract states **what every independently owned live handle must let a
caller do**. It deliberately does not declare the method signatures.

That boundary was drawn the hard way. An earlier revision of this amendment
declared a concrete `RunOutcomeBase` surface — `snapshot()`, `subscribeSnapshot()`,
`children()`, `abortChild()`, `closed()` — and three rounds of review found the
same failure repeatedly: every prose refinement created a new obligation on those
signatures, and each fix introduced a fresh inconsistency (`abortChild` declared
`void` here and `boolean` there; an "awaitable durable acknowledgement" promised
with no method to carry it). The signatures belong to the issues that implement
them, which have the runtime context to get them right. This document fixes the
requirements those signatures must satisfy, and nothing more.

| Capability                      | What it must guarantee                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Signature owned by |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------- |
| Cached snapshot                 | A framework-neutral, immutable read with stable identity and a monotonic `revision`. Reading never starts work, never blocks, never mutates. Repeated reads before a represented change return the identical object by reference, so callers diff by identity.                                                                                                                                                                                                                                                                                                                                                                                                | AB-88              |
| Non-consuming state observation | Any number of independent observers on one resource. Disposal ends _that_ observation only — never the work, never another observer's. A newly registered observer receives the current state before registration returns, closing the read-then-subscribe gap. Subscribing to already-terminal work delivers the terminal state immediately.                                                                                                                                                                                                                                                                                                                 | AB-88              |
| Child discovery                 | The ownership graph is inspectable from the root to arbitrary depth. Runtime-created children stay visible even when never returned to a caller. Descriptors carry enough edge information to reassemble the tree without promoting any child to an independently owned resource.                                                                                                                                                                                                                                                                                                                                                                             | AB-50              |
| Scoped child cancellation       | Cancelling one child never propagates to its siblings. Idempotent: a repeat request, or one against already-terminal or unknown work, is not an error. It is distinct from `abort()`, which AB-15 fixed and this amendment does not change.                                                                                                                                                                                                                                                                                                                                                                                                                   | AB-50              |
| Cleanup acknowledgement         | Awaitable, and always resolves rather than rejecting — a failed or unresolved teardown is a value, not a thrown error. It reports at least: cleanup was not required, completed, failed, or could not be determined. For durable work **whose cleanup follows a cancellation request**, a **successful** acknowledgement resolves only after that cancellation record is committed; work that ran to normal completion has no such record and must not be held behind one. A persistence failure resolves with the failed or undetermined outcome instead — never hangs waiting for a write that will not land, and never reports success without the record. | AB-37              |

Each capability's owning issue carries one obligation beyond delivering it:
**remove its entry from `scripts/documentation-examples.test.ts`** when the
signature lands. The names in that map are placeholders, since this amendment
leaves naming to the owning issue, so nothing in that harness can detect a
capability shipped under a different name. The obligation is recorded here
because this is the only place it can be enforced.

Two constraints bind every implementer of the above, and are the part this
document is actually deciding:

**Vocabulary.** Where a concept matches armorer's existing one exactly, adopt
armorer's term rather than inventing a synonym — `revision`, and the cleanup
outcome set `not-required | completed | failed | unresolved`
(`packages/armorer/src/execution-lifecycle.ts:26`). Where no exact match exists,
do not contort the surface to borrow one; `ExecutionHandle` carries
execution-machinery members with no public equivalent, and coupling a public API
to another package's internals makes every upstream change a breaking rename.

**Naming.** The state-observation capability must not be called `subscribe`.
`ActiveRun.subscribe` (`create-run.ts:53`) and `Bureau.subscribe`
(`create-bureau.ts:3800`) already mean _event_ subscription in this package, and
reusing the name for state observation on a sibling handle would read as the same
thing and mean something else.

### Handles versus locators

An in-process live start returns a handle synchronously and non-thenably—this already holds for `AgentRun` and is unchanged. A detached or durable start returns a _locator_: a value that names the work (typically its `id`, sometimes wrapped with the fields a caller needs to reattach) and that remains listable, retrievable, and reattachable through the owner named in the identity. A locator is not required to be delivered synchronously.

**These are not alternatives, and a durable start can owe both.** A durable `bureau.run()` is an in-process live start _and_ a durable one: AB-15 fixes it to return a synchronous `AgentRun`, and the work is separately reachable through `Bureau.getDurableRun(runId)`. Read as alternatives, the two rules would prescribe two different return shapes for one call, which this amendment explicitly does not do. So the locator requirement binds **the owner's surface, not the handle's shape**: a durable start that also returns a live handle satisfies the handle rule by its return value and the locator rule through its owner. That the handle itself carries no id is a recorded gap on the agent-run row, owned by AB-88 — a gap in the handle, not a contradiction between the rules. A durable start with _no_ live handle — a schedule, a scheduler submission — must deliver the locator itself, since there is nothing else to reach the work through. `createSchedule` returns `Promise<{...}>` because a durable submission genuinely has to touch storage before a stable identifier exists, and that is conforming rather than an exception.

`submitSchedulerTask` also returns a promise, but for an unrelated reason and it should not be read as the same thing: it detaches `runtime.scheduler.submit(task)` and immediately resolves with a `taskId`, so awaiting the receipt proves neither persistence nor that submission completed. That is an ordinary asynchronous API shape, not a storage acknowledgement — consistent with the classification table, which records scheduler submissions as process-local and as a declared non-conformance owned by AB-180. The synchronous, non-thenable requirement binds live handles specifically, because a live handle represents work already running in this process with no persistence step in the way; it does not bind every value this contract calls a locator.

### Abort and cleanup

`abort(reason?: string): void` is idempotent everywhere: calling it once cancellation has already been requested, or after the work is already terminal, has no additional effect and never throws. Today's `AgentRun.abort()` already satisfies this by construction—it forwards to `AbortController.abort()`, which is idempotent on its own terms. `abort()` only _requests_ cancellation; it does not itself report that teardown finished. A separate cleanup acknowledgement reports the outcome honestly, with the
guarantees listed under [Required capabilities](#required-capabilities). It is
awaitable and always resolves: a failed or unresolved teardown is a value, not a
thrown error, so a caller awaiting cleanup always gets an answer rather than
wrapping the call to discover whether cleanup itself failed. AB-37 owns its
signature.

**Bureau's `abortRun` is a known non-conformance, not a new rule.** `packages/bureau/src/create-bureau.ts:2916` throws `BureauError('Run is already {status}', 'CONFLICT')` when `abortRun(id)` is called against a run that is not currently `'running'`. That is not idempotent—a second `abortRun` call, or a call arriving after the run finished on its own, fails instead of returning an already-terminal outcome. This amendment does not fix it (no runtime code changes here); it records the gap, names `packages/bureau/src/create-bureau.ts:2916-2929` as its exact location, and assigns remediation ownership to AB-37, which owns cancellation and asynchronous shutdown and already covers the durable fencing and cleanup-acknowledgement semantics this fix depends on. Filing it separately now would likely be rewritten once AB-37 settles those semantics. Until that remediation lands, `abortRun` is a **declared exception** to the idempotent-abort rule—the same escape hatch the vault brief's Definition of Done anticipates ("the decision document records intentional exceptions and their owners")—not a silent contradiction.

Armorer's existing `ExecutionHandle.abort(source?, reason?): boolean` (`packages/armorer/src/execution-lifecycle.ts:80`) already conforms: it returns whether _this_ call changed anything, so a repeated call returns `false` rather than throwing. Its `whenSettled(): Promise<ExecutionSnapshot>` (line 83's neighbor) is the closest existing prior art for the cleanup acknowledgement this contract requires, and its `ExecutionCleanupOutcome` (`'not-required' | 'completed' | 'failed' | 'unresolved'`, line 26) is the outcome set [Required capabilities](#required-capabilities) adopts. The naming and vocabulary constraints recorded there — borrow armorer's terms where the concepts match exactly, and do not call state observation `subscribe` — bind whoever declares the signatures.

Parent-owned children are targetable without becoming independently owned resources: a parent handle must expose both child discovery and scoped child cancellation (see [Required capabilities](#required-capabilities)) without any child gaining its own Bureau-reachable locator by default. This is the same selector-based spirit armorer's `ExecutionLifecycle.inspect(selector?)`/`abort(selector?)` already uses at the tool-execution layer—one identifier in, one target affected—and it is how "abort one child without canceling its sibling" (named explicitly in AB-34's verification walk) is satisfiable without contradicting the intake clarification's parent-owned default.

### Durable cancellation

For any operation classified _durable_ above, a cancellation request is recorded — written to durable storage — before the cancellation is permitted to be **acknowledged** as durable.

That acknowledgement is necessarily asynchronous, and the contract says so rather than leaving an implementer to square it with a synchronous signature. `Bureau.abortRun(id)` returns synchronously and AB-15 fixed that shape; a synchronous return cannot have awaited a durable write, so its return value means _the cancellation was requested and accepted_, not _it is durably recorded_. The durable guarantee is carried by the awaitable path — `closed()` on a live handle, and the equivalent awaitable acknowledgement on a durable locator — which resolves only after the record is committed. A caller that needs the durable guarantee awaits; a caller that only needs to request cancellation does not. Requiring the synchronous return itself to imply durability would have forced AB-37 either to break `abortRun`'s ratified shape or to quietly violate this ordering. A stale attempt (one operating against a since-superseded lease or generation) is fenced: its writes after the cancellation was recorded are rejected rather than silently applied. The cancellation state remains observable across a process restart—a caller that reattaches after a crash sees the same cancellation-in-progress or cancellation-complete state a caller that never disconnected would have seen. None of this claims to reverse a side effect a tool, provider, or hook already committed outside the process; where the outcome of such an effect is unknown, the durable record preserves attempt and idempotency evidence instead of asserting a rollback that did not happen. Authoritative durable event observation for any of this is natively blocked by WFT-83, per AB-34's own dependency note—this amendment defines the contract these guarantees must satisfy; it does not claim Weft already satisfies it.

### Detachment

Detachment changes cancellation propagation without erasing causal lineage. A detached operation — independently owned, asynchronous, running without a controlling owner — keeps its `parentId` and its place in the ownership graph exactly as it had one; what changes is that an `abort()` issued against its former parent no longer implicitly reaches it.

**Detachment is an explicit lifecycle transition, never a consequence of subscriber count.** Work becomes detached because something detached it — the owner handed off control, or the operation was started detached — and that transition is recorded on the snapshot. It is not inferred from observers coming and going.

This matters because the alternative silently contradicts an invariant stated earlier in this document: disposing a subscription ends _that_ observation and never affects the work. If losing the last observer detached an operation, then unsubscribing would change whether a later parent `abort()` reached it — disposal would be quietly rewiring cancellation. Subscribing and unsubscribing are therefore free of lifecycle meaning: any number of observers, including zero, may come and go without altering ownership, propagation, or identity. Reattaching an observer likewise changes nothing but the observer count.

### Authorization, redaction, retention, and unsupported capabilities

Typed outcomes, not exceptions-as-control-flow, for the cases the acceptance criteria names by name:

Authorization denial is, by default, indistinguishable from not-found: `get`, `list`, `events`, `result`, `children`, `abort`, and `cleanup` all treat a caller with no visibility into a resource the same way they treat a resource that never existed, so that an unauthorized caller cannot use response shape to confirm something exists that they cannot see. A deployment MAY declare a stricter mode that returns a distinct denial outcome instead—that is an explicit, per-deployment opt-in, never the default.

Redaction is a second, separate projection, not a side effect of authorization: `snapshot()`, `subscribeSnapshot()`'s delivered values, `events`, and `result` each expose a redacted projection to any caller by default, and a privileged, unredacted projection only to a caller whose authorization explicitly grants it. Armorer ships this split as **twin accessors** — `ExecutionHandle.snapshot()` versus `privilegedSnapshot()`, and `ExecutionLifecycle.inspect()` versus `inspectPrivileged()` (execution-lifecycle.ts:73, 105, 118). That is _one conforming implementation_, not the required shape.

What this amendment requires is the **projection distinction**, not a particular accessor count. A resource satisfies it either way:

- **Twin accessors**, as armorer does — a redacted method and a privileged sibling.
- **Authorization-selected** — a single accessor whose returned projection is determined by the principal **of whoever is observing, resolved at observation time**. Not the principal that started the work: `BureauRunOptions.principal` identifies the starter only, and a handle can be passed to another caller, so binding the projection at creation would hand the privileged view to anyone holding the handle.
- **Projection-bound**, where a handle carries a fixed projection decided when it was issued, and obtaining a differently-projected view means obtaining a different handle.

**Standalone runs are a declared gap.** `AgentRunContext` carries no principal at all, so a `RunnableAgent.run` handle has no authorization input to select against and no issuer to bind a projection at. Such a run has exactly one projection, and this contract does not pretend otherwise. AB-88 owns deciding whether standalone runs gain a principal or are declared single-projection permanently; either is defensible, and neither may be assumed.

Requiring twin accessors universally would have forced a `privilegedSnapshot()` onto `AgentRun`, which has no authorization argument and no way to acquire one without reopening AB-15's fixed signatures. What a caller must never have to do is _guess_ which projection it received: whichever form a resource picks, the projection in force is stated on the snapshot itself, so a caller reads it rather than inferring it.

Retention expiry returns a typed `expired` locator-resolution outcome, distinct from not-found — the resource existed, but the evidence has been retired. This is what lets a caller tell "this never existed or you can't see it" apart from "this happened and is now gone."

**Authorization is evaluated first, and expiry never widens visibility.** `expired` is returned only to a caller who would have been authorized to see the resource while it existed. Every other caller receives the ordinary not-found projection, exactly as they would have before expiry. Returning `expired` to an unauthorized caller would confirm that an id once named something real — the precise inference the not-found default exists to prevent — and would make retention expiry a probing oracle: an attacker who could not distinguish ids today could simply wait.

An unsupported capability is declared, not discovered by failure: every snapshot's `cancellable` field (and any resource-specific durability flag) is set at construction time, so a caller can tell _before_ invoking whether a capability exists.

The typed `unsupported-capability` outcome applies to **locator APIs only** — the `Bureau.abortRun`-style operations that already return a value and can therefore carry one. It deliberately does **not** apply to a live handle's `abort()`. AB-15 fixed that signature as `abort(reason?: string): void`, non-throwing, and this amendment does not reopen it; a `void` method has no channel for a typed outcome, so requiring one would make the two rules mutually unsatisfiable. On a handle whose snapshot declares `cancellable: false`, `abort()` is a no-op that neither throws nor changes state, and its non-effect is observable the honest way: the snapshot's `status` does not move to a cancelling state, and `closed()` resolves `not-required`. Callers who need a typed refusal use the locator API.

Observing work that is already terminal is not a missed-transition bug: the deliver-current-state-on-registration guarantee in [Required capabilities](#required-capabilities) means a terminal-before-observation caller receives the terminal state immediately, satisfying "monitor a result without missing it" the same way a not-yet-terminal caller's normal transition delivery does.

Reusing an idempotency key for a request that does not canonically match the original returns a typed conflict outcome, never a silent overwrite and never a second start—this is the vocabulary section's idempotency-key rule restated as a control-flow requirement.

### Test-helper parity

A test helper may supply a deterministic clock, a scripted dependency, or a concise assertion wrapper. It may not expose a lifecycle-control or introspection capability the production surface does not also expose through this same contract—a test build of a handle is a convenience wrapper over the real contract, never a parallel, more-powerful one.

### Not decided

Deliberately deferred, each with the reason. None is an oversight, and none is
left implied to exist:

**A compaction attempt gets no independent locator.** It stays parent-owned and
embedded, observable through its owning session or run. If cross-run compaction
observability becomes a real operator need — a stuck compaction blocking a
session with no way to see it independently — that is a scope change to this
contract, not a gap in it. No current code path or named issue asks for it.

**No issue is named for an independently owned background evaluation runner**,
because none exists. The two evaluation paths that ship today are classified in
the table above. Filing the issue that would build a reattachable evaluation
runner is a follow-up action for whoever needs it, not a decision this document
can make alone.

**Idempotency-key request and receipt shapes remain unowned for every
operative-level start operation except one.** AB-42 fixes
`SessionInputRecord`/`SessionInputReceipt`/`SessionInputState` for
session-input admission, scoping its idempotency key to
`(principal, 'session-input', id)`, the same `(principal, operation, key)`
shape `POST /hooks/*` already uses, with the canonical request
`(sessionId, deliveryMode, payloadDigest)` a retry must match exactly to
replay rather than conflict. Every other start operation (`AgentRunContext`,
`BureauRunOptions`, `DurableScheduleDefinition`) still lacks a key entirely.

This is deliberately narrower than it used to read. The gateway route
`POST /hooks/*` already accepts an `Idempotency-Key` and conforms within its
documented process-local boundary; AB-109 owns durable cross-instance receipt
storage. A flat claim that no start operation accepts a key would still
contradict the shipped route classified two sections earlier.

### Illustrative examples

Three scenarios from AB-34's own acceptance-criteria bullet, showing what the
[required capabilities](#required-capabilities) look like in use.

**These are not compile-ready and are not normative on naming.** The member names
below are placeholders for the capabilities, not declarations — this amendment
deliberately does not declare the signatures, so AB-88, AB-50, and AB-37 may
choose different names as long as they satisfy the guarantees and honour the two
constraints recorded above. What the examples _do_ fix is the shape of each
scenario: what a caller must be able to accomplish, and in what order.

`scripts/documentation-examples.test.ts` tracks every capability these examples
exercise against its owning issue, so a member cannot appear here without an
owner, and an owner cannot disappear while the example still calls it.

```ts
// A direct run: snapshot and subscribe alongside the existing result()/unwrap().
const run = bureau.run('researcher', 'Summarize the Q3 report.');
const unsubscribe = run.subscribeSnapshot((snapshot) =>
  console.log(snapshot.status, snapshot.revision),
);
console.log(run.snapshot().status); // the cached read: starts nothing, blocks on nothing
const cleanup = await run.closed(); // resolves with the cleanup outcome, never rejects
const result = await run.result();
unsubscribe();

// A nested child, discovered through its parent without a standalone locator.
const parentRun = bureau.run('planner', 'Break this project into tasks.');
const firstChild = parentRun.children()[0]; // parent-owned descriptor, not an independent handle
if (firstChild) {
  parentRun.abortChild(firstChild.id, 'no longer needed'); // scoped: this child only, siblings unaffected
}

// A detached durable operation—a schedule fire—reattached and canceled after restart.
const schedule = await bureau.createSchedule({
  agentName: 'nightly-report',
  input: 'Compile the nightly report.', // required: the message delivered on each fire
  spec: '0 2 * * *', // cron expression or a weft duration shorthand such as '6h'
});
// ...a fire runs, and the process restarts before it finishes.
//
// Discovery is the whole point of this example, so it must not be assumed. There is
// no public schedule-to-fire accessor today: `ScheduleSummary` and `RunSummary`
// expose none, and the durable `KEYS.scheduleRun(runId)` marker is an internal
// reverse mapping that already requires the run id you are trying to find. AB-41
// owns closing that gap; the accessor is declared here so this example shows a
// reattachment path rather than fabricating an identifier.
declare function listScheduleFires(scheduleId: string): Promise<readonly RunSummary[]>;

if (schedule) {
  const fires = await listScheduleFires(schedule.id);
  const inFlight = fires.find((fire) => fire.status === 'running');

  // What a caller CAN do after a restart: stop future fires.
  await bureau.cancelSchedule(schedule.id);

  // What a caller CANNOT do today: cancel this recovered fire.
  //
  // `bureau.abortRun(inFlight.id)` would throw NOT_FOUND. Boot recovery routes a
  // native scheduled fire down the `monitor` path, which deliberately does not
  // register an ActiveRun (`create-bureau.ts:545-551`), and `abortRun` reads only
  // the process-local store and throws when the run is absent
  // (`create-bureau.ts:2916-2920`). No engine-backed per-run cancellation exists
  // on the Bureau surface: `cancelSchedule` cancels the definition, not a fire.
  //
  // This is the contract's most consequential declared non-conformance, because
  // durable cancellation is the one guarantee a restart is supposed to preserve.
  // AB-37 owns it. See the schedule-fire row in the classification table.
  void inFlight;
}
```

## Session input admission

AB-42's decision record ("Define durable session-input admission and delivery
semantics"), ratified 2026-09-01. Session-input admission is a fourth Bureau
session verb, illustratively named `submitSessionInput` throughout this
section, alongside the existing `signalSession`, `updateSession`, and
`querySession`, with the exact method name left to the implementing issue, and
stays off `AgentRun`, matching AB-39's ratified rule that Weft-shaped command
surfaces live on Bureau's session handle. Every admitted input is a
`SessionInputRecord` identified by a caller-supplied-or-generated `id`, bound
to a `sessionId` and authenticated `principal`, carrying a `deliveryMode` of
`steer` or `queue`. The idempotency key scope is
`(principal, 'session-input', id)`, exactly as `POST /hooks/*` scopes its key
to `(principal, operation, key)` (`packages/gateway/src/routes/hooks.ts:29-31`);
the canonical request that key must match on retry is
`(sessionId, deliveryMode, payloadDigest)`. An exact match replays the
original `SessionInputReceipt`; a mismatch on any of those three fields
returns a typed conflict. Eight terminal-inclusive states (`accepted`,
`queued`, `promoted`, `rejected`, `expired`, `superseded`, `canceled`,
`failed`) cover the lifecycle, and `promoted` is reached only through one
dedicated workflow step whose entire body is a single `conditionalBatch`
(WFT-83's transaction-composable append contract) that commits the
model-visible message and the record's terminal state together. `steer` means
eligible at the next safe provider-turn boundary (a term AB-67 refines),
`queue` means strict FIFO admission order, and neither ever retargets an
in-flight provider request. The runtime that claims, drains, and persists
these records is Weft's application command mailbox (WFT-84, unreleased);
this record defines the shapes WFT-84's mailbox must carry and Bureau must
project, and forbids a private durable inbox in the interim. Classified
against AB-34's axes, a session input is parent-owned and addressable,
asynchronous, and durable exactly when the session's own backing store is.

### An input has a stable caller-supplied or generated identifier, session identity, authenticated sender, serialized payload, delivery mode, admission revision, timestamps, and expiry or retention policy

```ts
export type SessionInputDeliveryMode = 'steer' | 'queue';

/** The subset of `MultiModalContent` (`packages/conversationalist/src/multi-modal.ts`) a caller
 *  may submit as session input: `TextContent` (citation metadata omitted — see below),
 *  `ImageContent`, and `DocumentContent`. An explicit allowlist, not `Exclude<MultiModalContent,
 *  ...>` against the provider-generated/response-only kinds (`ThinkingContent`,
 *  `RedactedThinkingContent`, `ServerToolUseContent`, `WebSearchToolResultContent`,
 *  `ServerToolResultContent`, `ContainerUploadContent`): `conversationalist` is consumed at a `^`
 *  semver range, and a blacklist silently admits any new `MultiModalContent` variant a future
 *  compatible release adds, defeating AB-70's ownership of widening this union deliberately. Every
 *  excluded kind is either rejected outright (the Anthropic adapter throws serializing
 *  `container_upload` and the other response-only blocks as request content), silently dropped
 *  (the OpenAI and Gemini adapters serialize only text, document, and image content), or
 *  misattributed if replayed as if the user had sent it.
 *
 *  The text branch forbids `citations` structurally (`citations?: never`), not merely via
 *  `Omit<TextContent, 'citations'>`: TypeScript's structural typing means `Omit<>` alone only
 *  drops the property requirement — a value already typed as `TextContent` (with `citations`
 *  set) is still assignable to `Omit<TextContent, 'citations'>`, since excess properties on a
 *  non-literal source go unchecked. `citations?: never` makes any non-`undefined` `citations` a
 *  type error at every call site, literal or not. */
export type UserAdmissibleContent =
  | (Omit<TextContent, 'citations'> & { readonly citations?: never })
  | ImageContent
  | DocumentContent;

/** The message-shaped subset of the document's `AgentInput` this contract accepts: exactly
 *  what one `Message.content` can hold (`string | ReadonlyArray<MultiModalContent>`, matching
 *  `packages/conversationalist/src/types.ts:140`), narrowed to `UserAdmissibleContent`. The
 *  `{ conversation }` variant of `AgentInput` is out of scope for session-input admission; a
 *  caller with a full conversation to inject uses Bureau's conversation-replacement surface.
 *  AB-70 owns any future widening of the admissible content within this message-shaped
 *  constraint. */
export type SessionInputPayload = string | ReadonlyArray<UserAdmissibleContent>;

export interface SessionInputRecord<TPayload extends SessionInputPayload = SessionInputPayload> {
  /** Caller-supplied idempotency identity, or server-generated when the caller omits one. */
  readonly id: string;
  readonly idOrigin: 'caller' | 'generated';
  readonly sessionId: string;
  /** Authenticated sender. Required, unlike `StartedWorkIdentity.owner`. */
  readonly principal: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  readonly payload: TPayload;
  /** Content-addressed digest of the canonicalized payload; part of the idempotency binding. */
  readonly payloadDigest: string;
  readonly admittedAt: string; // ISO
  /** The record's own eligibility deadline. Absent means no deadline. Distinct from
   *  post-terminal retention, which the document's line 569 rule governs separately. */
  readonly expiresAt?: string; // ISO
  /** Present only when admitted as an explicit successor to a still-pending input. Never inferred. */
  readonly supersedes?: string;
}
```

`admission revision` is the per-record `revision` on the receipt, not a session-wide counter; it increments on every state transition of this record, reusing this document's `StartedWorkSnapshot.revision` vocabulary.

**Coordinator amendments (2026-09-02).** Three findings raised during AB-193's review (Codex reviewer on pull request #397) were real gaps in the ratified record above; the coordinator resolved them, and AB-202 applies the resulting type changes:

- **Bounded payload generic.** `SessionInputRecord<TPayload extends SessionInputPayload = SessionInputPayload>` and `SessionInputAdmissionRequest<TPayload extends SessionInputPayload = SessionInputPayload>`. An explicit type argument can narrow the payload, never widen it past the admissible union. Future widening remains AB-70's, by widening `SessionInputPayload` itself.
- **User-admissible payload only.** `SessionInputPayload` allowlists only `TextContent` (minus `citations`), `ImageContent`, and `DocumentContent` — see `UserAdmissibleContent` above, an explicit union rather than an `Exclude<>` blacklist so a future `conversationalist` release cannot silently widen it. Promotion turns a payload into user input, and every excluded kind is either rejected outright (the Anthropic adapter throws on `container_upload` and the other response-only blocks, and on malformed `citations`), discarded (the OpenAI and Gemini adapters silently drop `container_upload`), or misattributed by provider adapters. The exclusion is type-level in operative and enforced at runtime by the gateway request schema (AB-196), which rejects them with 400; Bureau's `submitSessionInput` treats a payload containing them as malformed and never admits it.
- **Identifier uniqueness within a session.** A session-input `id` is unique within its `sessionId` regardless of principal. The idempotency key stays `(principal, 'session-input', id)` for replay detection by the same principal; a different principal submitting an `id` that already exists in the session receives the `conflict` outcome with `SessionInputConflict.reason: 'id-owned-by-other-principal'` (see below) and the existing record is untouched. This keeps `id` sufficient as the record's child identity in the session's ownership graph (the AB-50 amendment) without a composite identifier.

### Exact retry of the same identifier and payload returns the original receipt and does not duplicate a run or model-visible message; conflicting reuse returns a typed conflict

```ts
export type SessionInputAdmissionOutcome =
  | { readonly outcome: 'admitted'; readonly receipt: SessionInputReceipt }
  | { readonly outcome: 'replayed'; readonly receipt: SessionInputReceipt }
  | { readonly outcome: 'conflict'; readonly conflict: SessionInputConflict }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'session-terminal'; readonly sessionId: string }
  | { readonly outcome: 'unsupported-capability'; readonly reason: string }
  | {
      readonly outcome: 'backlog-exhausted';
      readonly scope: 'session' | 'principal';
      readonly limit: number;
    };

/** Caller-facing admission request. `SessionInputRecord` is the persisted, server-computed shape
 *  (`idOrigin`, `payloadDigest`, `admittedAt` are assigned by admission). `principal` is included
 *  here, matching `BureauRunOptions.principal`'s placement; the calling layer (the gateway's
 *  `resolvePrincipal(context)`, `hooks.ts:152`) attaches it from the authenticated request. The
 *  gateway body schema for `POST /sessions/:id/input` is `Omit<SessionInputAdmissionRequest,
 *  'principal'>`; a body-supplied `principal` is never trusted. */
export interface SessionInputAdmissionRequest<
  TPayload extends SessionInputPayload = SessionInputPayload,
> {
  readonly id?: string;
  readonly principal: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  readonly payload: TPayload;
  readonly expiresAt?: string; // ISO
  readonly supersedes?: string;
}

// Illustrative: submitSessionInput(sessionId: string, request: SessionInputAdmissionRequest): Promise<SessionInputAdmissionOutcome>

export interface SessionInputReceipt {
  readonly id: string;
  readonly sessionId: string;
  readonly deliveryMode: SessionInputDeliveryMode;
  /** Server-assigned per-session FIFO position, distinct from `revision`. */
  readonly admissionSequence: number;
  readonly revision: number;
  readonly state: SessionInputState;
  readonly admittedAt: string;
}

export interface SessionInputConflict {
  readonly id: string;
  /** `'id-owned-by-other-principal'`: a different `principal` submitted an `id` that already
   *  exists in the session; see the "Identifier uniqueness within a session" amendment above. */
  readonly reason:
    | 'session-mismatch'
    | 'delivery-mode-mismatch'
    | 'payload-mismatch'
    | 'id-owned-by-other-principal';
  readonly originalReceipt: SessionInputReceipt;
}
```

`replayed` and `conflict` both key off `(principal, 'session-input', id)`. A different `sessionId`, `deliveryMode`, or `payloadDigest` under the same key reports the corresponding mismatch reason; an exact match replays the original receipt. A different `principal` is a different scope for replay detection (a colliding `id` across principals is the `'id-owned-by-other-principal'` conflict; see the coordinator amendments above). This is `hooks.ts`'s `requestFingerprint` check (`hooks.ts:169-186`) generalized, and the first operation to spend the idempotency-key semantics this document left unowned at the line noted in [Started-work control contract](#started-work-control-contract). A concurrent identical retry while admission is in flight shares the same in-flight promise, as `hooks.ts`'s reservation-before-start pattern does (`:163-196`).

`not-found` covers both "no such session" and "caller unauthorized", indistinguishable by design per this document's authorization-denial rule. `session-terminal` fires only for an authorized caller whose session exists but is already terminal, mirroring this document's `expired`-versus-not-found split. Neither carries a record; both are pre-admission rejections. Pre-admission checks run in a fixed order: authorization (`not-found`) first, then session lifecycle (`session-terminal`), then capability and capacity (`unsupported-capability`, `backlog-exhausted`); reversing the first two would let an unauthorized caller learn a session exists.

### `steer` means eligible at the next safe provider-turn boundary; `queue` means FIFO after earlier queued input when the current drain would otherwise become idle. Unsupported modes reject before admission

- `steer`: eligible for promotion at the next safe provider-turn boundary (AB-67 defines the boundary precisely). Multiple `steer` inputs admitted before that boundary are not coalesced: each keeps its own record and place in admission order (by `admissionSequence`), and all become eligible together. Coalescing exists only for the wake trigger, never for message content; the only way one pending input retires another is the explicit `supersedes` reference.
- `queue`: strict FIFO by `admissionSequence`; eligible only once every earlier-queued, not-yet-terminal input for the same session has reached `promoted` (or a terminal-failure state), and only when the current drain would otherwise become idle.
- **Rejecting unsupported modes**: a `deliveryMode` outside `'steer' | 'queue'`, or one the session configuration cannot honor, returns `{ outcome: 'unsupported-capability' }` synchronously before any record is created, reusing this document's locator-API outcome.

### Accepted, queued, promoted, rejected, expired, superseded, canceled, and failed states are inspectable and observable without inferring them from the transcript

```ts
export type SessionInputState =
  | 'accepted' // admitted, `steer` mode, waiting for the next safe boundary
  | 'queued' // admitted, `queue` mode, waiting for FIFO turn
  | 'promoted' // terminal-success: model-visible message and record committed together
  | 'rejected' // terminal-failure: authorization revoked, or session went terminal, after admission
  | 'expired' // terminal-failure: the input's own eligibility deadline passed before promotion
  | 'superseded' // terminal-failure: explicitly replaced by a named successor before promotion
  | 'canceled' // terminal-failure: caller or session-owner canceled before promotion
  | 'failed'; // terminal-failure: promotion was attempted and the session could not consume it
```

`expired` names the record's own eligibility deadline (`expiresAt`), transitioning with `SessionInputFailure.reason = 'deadline-passed'`; post-terminal retention is the separate clock this document's retention rule governs. `rejected` covers only post-admission causes; a cause that prevents a record from existing is a pre-admission outcome. A malformed payload is rejected before `submitSessionInput` at the gateway's schema boundary (400), as `hooks.ts` does for a malformed `CreateRunRequest`.

`SessionInputSnapshot` is the observation surface (AB-88's signature to build). It satisfies `StartedWorkSnapshot`'s fields structurally by inlining them, not by `extends`; applying that floor to a parent-owned resource is a deliberate decision because AB-87 needs `revision`, `status`, and `lastTransitionAt` on every started-work kind.

```ts
export interface SessionInputSnapshot {
  readonly id: string; // SessionInputRecord.id
  readonly kind: 'session-input';
  readonly owner?: string; // SessionInputRecord.principal
  readonly parentId: string; // sessionId, always present for this kind
  readonly startedAt: string; // SessionInputRecord.admittedAt
  readonly revision: number;
  readonly status: SessionInputState;
  readonly lastTransitionAt: string;
  readonly projection: 'redacted' | 'privileged';
  readonly ownership: 'parent-owned';
  readonly detached: false;
  readonly durability: WorkDurability; // inherited from the owning session
  readonly cancellable: boolean; // false once `status` is terminal
  readonly result?: SessionInputPromotion | SessionInputFailure;
  readonly record: SessionInputRecord;
  readonly admissionSequence: number;
}
```

It is observed through the owning session's ownership graph (AB-50's child-discovery capability), not a standalone locator. This document's Session row scopes AB-50 to runs only; extending it to session-input records is a scope change AB-42 makes explicitly, reflected in the [classification table](#classification-table) above. No new top-level `getSessionInput(id)` locator is introduced.

### Promotion atomically commits the model-visible message and the input's promoted state; a crash cannot expose one without the other

Atomicity does not rest on `ctx.memo` alone. `ctx.memo` (Weft
`src/core/context/parallel-operations.ts:304-335`, mirrored at
`run-workflow.ts:458-474`) caches a step's return against the workflow's
checkpoint store and re-runs `fn()` in full on a replay whose checkpoint has
not landed; it says nothing about coordinating a write to a second store. The
atomicity comes from WFT-83's transaction-composable append contract: the
promotion step issues one `conditionalBatch`
(`packages/weft/src/storage/typed-storage.ts:211-278`; per-backend at
`lmdb.ts:241`, `indexeddb.ts:389`, `postgres-key-value-storage.ts:54-66`)
carrying both the mailbox record's transition to `promoted` and the
`ConversationHistory` append. This requires the session store and WFT-84's
mailbox to share one storage backend, grounded in the composition chain
`sessions.ts:23-31` documents (`durable ⟹ durableStorage ⟹ kv ⟹
sessionStore`).

The batch is conditional: its precondition is that the mailbox record is
still `accepted`/`queued` at commit time (WFT-84's attempt-fenced claim). If a
crash lands between the batch committing and `ctx.memo`'s own checkpoint, the
step re-enters on replay, the precondition fails because the record is
already `promoted`, and the step reads that as "the prior attempt already
committed": it fetches the existing `SessionInputPromotion` and returns it.
Promotion is its own dedicated memo step, never folded into the generate
step, because a replay of an in-flight generate step would re-invoke the
provider call.

```ts
export interface SessionInputPromotion {
  readonly promotedAt: string; // ISO
  readonly conversationMessageId: string; // the message this input became
  /** Ordinal of the provider-turn boundary this input was consumed at. AB-67 owns the boundary's definition. */
  readonly providerTurn: number;
}

/** Populated on every terminal-failure `SessionInputState`. */
export interface SessionInputFailure {
  readonly failedAt: string; // ISO
  readonly reason:
    | 'session-terminal'
    | 'authorization-revoked'
    | 'deadline-passed'
    | 'superseded-by' // pairs with `SessionInputRecord.supersedes` on the successor
    | 'caller-canceled'
    | 'promotion-failed';
}
```

`conversationMessageId` is `Message.id`
(`packages/conversationalist/src/types.ts:138`; `ConversationHistory.messages`
is keyed by it at `:176`, with `ids` at `:175`). `providerTurn` is the
generate step's `stepIndex` (the value `run-workflow.ts:474`'s
`ctx.memo('step-${stepIndex}', ...)` keys by), copied into the record rather
than minting a second counter. Three crash windows (before the batch, between
the batch and the memo checkpoint, after both) produce one observable outcome
each and no duplicate.

### The contract defines per-session and per-principal backlog limits, backpressure, wake coalescing, concurrent admission, authorization, terminal-session behavior, cancellation, and restart recovery

| Concern                   | Decision                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backlog limits            | Two independent caps checked at admission: a per-session cap over all not-yet-terminal records, and a per-principal cap over that principal's records against that session. Either breach returns `{ outcome: 'backlog-exhausted', scope, limit }`, no record persisted.                                                                 |
| Backpressure              | A caller that hits `backlog-exhausted` retries after a terminal state opens capacity; no server-side retry-after, matching AB-15's fixed option shapes.                                                                                                                                                                                  |
| Wake coalescing           | Multiple inputs or signals arriving while a run is idle collapse to one wake dispatch; every record is still promoted individually and in order.                                                                                                                                                                                         |
| Concurrent admission      | Distinct `id`s admit independently, ordered by server-assigned `admissionSequence` (ties broken by `id` lexical order). A race on the same `(principal, 'session-input', id)` key shares one in-flight admission via the `hooks.ts:163-196` reservation pattern.                                                                         |
| Authorization             | Evaluated against the session's persisted owning principal and delegated authorization, per AB-39. Unauthorized admission returns `{ outcome: 'not-found' }`. Authorization revoked after admission produces `rejected` with `reason = 'authorization-revoked'`.                                                                         |
| Terminal-session behavior | A session already terminal at admission time, for an authorized caller, returns `{ outcome: 'session-terminal', sessionId }`. A session that terminates after admission but before promotion transitions the record to `rejected` with `reason = 'session-terminal'`.                                                                    |
| Cancellation              | Idempotent; canceling an already-terminal record is a no-op. Composes with AB-50's scoped child cancellation rather than introducing a distinct verb; the record's resulting state is always observable through AB-88's snapshot surface. Produces `canceled` with `reason = 'caller-canceled'`. Honored only strictly before promotion. |
| Restart recovery          | A session-input record's durability is the owning session's durability. A durable session recovers `accepted`/`queued` records as part of ordinary Weft workflow recovery (AB-39's Restart sequence).                                                                                                                                    |
| Pre-WFT-84 deployment     | A deployment running today's published Weft (`0.23.1`, no mailbox) cannot durably admit session input. `submitSessionInput` returns `{ outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' }`; the gateway surfaces it as 501 (`sessions.ts:104-105`, `:139-140`, `:179-180`), never a silent process-local queue.  |

## Steering commands

Decision record for AB-67. Eleven run-time operations split into three families. Admitted user-message steering (`deliveryMode: 'steer'`) and queued user input (`deliveryMode: 'queue'`) are AB-42's `SessionInputRecord`/`submitSessionInput` contract, unchanged. Workflow signal and update stay AB-39's `signalSession`/`updateSession` verbs, unchanged — they settle durable Weft waits and validated request/response exchanges against an already-parked run, not per-step generation configuration. Abort stays AB-15/AB-34's existing immediate, terminal, non-boundary-gated cancellation, only positioned in the vocabulary here.

The third family — agent-identity change, route selection, model change, provider change, effort change, pause, and resume — is what this section defines: `SteeringCommand`, one type shared by all seven because every one of them is "change the desired configuration a future step will read," never "act on the run right now." **Model, provider, route, effort, pause, and resume** apply at the entry of `runStep` (`packages/operative/src/run-step.ts:390-397`, immediately after the abort check and before backpressure), the one point shared verbatim by both the in-memory driver (`executeLoop`'s `for` loop, `loop.ts:113-114`) and the durable driver (`run-workflow.ts`'s per-step `ctx.memo`, `:457-499`): steering applies once per step, not once per provider attempt, never mid-generate (`:612-617`), never during tool execution (`:814-1097`), and never re-read on a same-step provider-error retry (`:556-738`). **Agent-identity** applies at step 0 of the session's next `bureau.run` call, never mid-run, because `RunOptions.toolbox`, `.generate`, and its hook registries are resolved once per run from the specific `RunnableAgent` invoked; switching which agent governs a run mid-flight would mean swapping its toolbox and hooks under a step already in progress, which this record treats as editing a protected run invariant. A `SteeringCommand` is parent-owned and addressable on its owning session, matching AB-42's classification of session input, and this section extends AB-50's already-once-widened Session row a second time to cover it (see the classification table above).

```ts
export type SteeringTargetKind =
  'agent-identity' | 'route' | 'model' | 'provider' | 'effort' | 'pause' | 'resume';

/** Discriminated by `target`. `pause`/`resume` carry no value: the target
 *  itself is the instruction. Every other target carries exactly one of
 *  `policyRef` (a named, pre-approved policy the selector resolves) or
 *  `override` (an exact value), encoded as an exclusive pair — `policyRef?:
 *  never` on the `override` arm and `override?: never` on the `policyRef`
 *  arm — rather than two same-discriminant variants, so a literal supplying
 *  both fields with non-`undefined` values, or neither field, is rejected by
 *  the type checker at compile time. This package's
 *  `exactOptionalPropertyTypes: false` means an explicit `override: undefined`
 *  alongside `policyRef` still type-checks — semantically indistinguishable
 *  from omitting `override` — so the runtime admission check that exactly
 *  one is *present* (not merely non-`undefined` in the type) stays
 *  load-bearing, not just defense in depth. */
export type SteeringRequestedValue =
  | { readonly target: 'pause' }
  | { readonly target: 'resume' }
  | { readonly target: 'agent-identity'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'agent-identity'; readonly override: string; readonly policyRef?: never } // a catalog agent name; must be a key of Bureau<D>'s agents map
  | { readonly target: 'route'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'route'; readonly override: string; readonly policyRef?: never } // must name a configured RoutingOptions.routes entry
  | { readonly target: 'model'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'model'; readonly override: string; readonly policyRef?: never }
  | { readonly target: 'provider'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'provider'; readonly override: string; readonly policyRef?: never }
  | { readonly target: 'effort'; readonly policyRef: string; readonly override?: never }
  | { readonly target: 'effort'; readonly override: Effort; readonly policyRef?: never }; // packages/operative/src/providers/types.ts:22-25

export interface SteeringCommand {
  readonly id: string;
  readonly idOrigin: 'caller' | 'generated'; // same idempotency shape as AB-42's SessionInputRecord
  readonly sessionId: string; // steering is a Bureau session verb (AB-39's ratified placement), never on AgentRun
  readonly principal: string;
  readonly requestedValue: SteeringRequestedValue;
  /** Optimistic concurrency against the session's own `configVersion` (below).
   *  Absent means "apply regardless of current desired state"; present means
   *  "reject as a conflict if configVersion has moved past this value." */
  readonly expectedRevision?: number;
  readonly requestedAt: string; // ISO
  readonly deadline?: string; // ISO, same semantics as AB-42's SessionInputRecord.expiresAt
  /** `pause`/`resume` only. When present, must name a non-terminal run
   *  owned by `sessionId`, or admission fails with the existing
   *  `SteeringCommandFailure.reason: 'run-terminal'`. When absent and the
   *  session has exactly one non-terminal run, the command binds to that
   *  run and the effective `runId` is recorded on the accepted command;
   *  when absent and the session has zero or more than one non-terminal
   *  run, admission fails with `'run-ambiguous'`. Configuration-targeting
   *  commands (`model`, `provider`, `route`, `effort`, `agent-identity`)
   *  remain session-scoped desired state and ignore `runId`. */
  readonly runId?: string;
}
```

`SteeringRequestedValue` is a union, never a bag with both `policyRef` and `override` optional. `policyRef` resolves through AB-66's selector — this record fixes that the resolution step exists and is mandatory, not what the selector's algorithm is. `override` is an exact value that still passes the same capability/authority checks a `policyRef` resolution would produce. Until AB-66 ships, no deployment can honor a `policyRef`- or `override`-carrying `SteeringCommand` for `route`/`model`/`provider`/`effort`: `submitSteeringCommand` (illustrative name) must return `{ outcome: 'unsupported-capability', reason: 'selector-unavailable' }`, mirroring AB-42's `'durable-mailbox-unavailable'` pre-WFT-84 fallback, never a silent direct write. `BureauRunOptions` is unchanged by this contract: no `model`, `provider`, `route`, `effort`, or `agentName` field is added to it — a `SteeringCommand` targeting these four values travels through the new session-scoped admission verb (illustratively `submitSteeringCommand`, alongside AB-42's `submitSessionInput` and AB-39's `signalSession`/`updateSession`/`querySession`), never as a field on the per-call `options` argument to `bureau.run`.

A `pause` or `resume` command targets exactly one run: when `runId` is present it must name a non-terminal run owned by `sessionId`, otherwise admission fails with the existing `'run-terminal'` reason; when `runId` is absent and the session has exactly one non-terminal run, the command binds to that run and the effective `runId` is recorded on the accepted command; when `runId` is absent and the session has zero or more than one non-terminal run, admission fails with `SteeringCommandFailure.reason: 'run-ambiguous'`.

```ts
/** Populated on every terminal-failure SteeringCommandState (`rejected`,
 *  `superseded`, `failed`), mirroring AB-42's SessionInputFailure. */
export interface SteeringCommandFailure {
  readonly failedAt: string; // ISO
  readonly reason:
    | 'session-terminal' // the owning session itself went terminal (closed) before application
    | 'run-terminal' // pause/resume only: the run it targeted ended (aborted or completed) before its gate could apply
    | 'run-ambiguous' // pause/resume only: no runId given and the session has zero or more than one non-terminal run
    | 'authorization-revoked'
    | 'policy-denied'
    | 'deadline-passed'
    | 'superseded-by'; // pairs with a successor command's id, same target
  /** The `id` of the successor command, present exactly when `reason` is
   *  `'superseded-by'` and absent otherwise. */
  readonly supersededBy?: string;
}
```

| Operation                         | Authority                                                                                                                                                                                   | Validation boundary                                                                                                                                                                                                                        | Application boundary                                                                                                                          | Acknowledgement                                                                                                                                                                          | Rejection                                                                                                                                               | Supersession                                                                                                                                                                                                           | Terminal behavior                                                                                                                                                                                                                                                                                          |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route / model / provider / effort | `principal` authorized on the session (AB-39's principal-as-only-authorization-input rule), and the requested `policyRef`/`override` permitted by whatever policy AB-66's selector enforces | At admission: session exists and is not terminal; for `override`, the exact value is one the deployment's catalog/routing table/provider registry actually has; for `policyRef`, the name resolves to a policy AB-66's selector recognizes | Entry of `runStep`; never mid-generate, mid-tool-execution, or on a same-step error retry                                                     | Synchronous admission outcome at request time (`requested`/`accepted`), then an asynchronous `applied` transition observable through the session's snapshot once the boundary is crossed | Typed conflict/`unsupported-capability`/`not-found`/`session-terminal`, same outcome shapes as AB-42                                                    | Admitting a new command for the same `target` while an earlier one for that target is still `accepted` (not yet applied) automatically transitions the earlier one to `superseded`; last-desired-value-per-target wins | `applied` once consumed by a step boundary in any current or future run on the session (desired state is session-scoped and outlives one run); `rejected` if invalidated post-admission; `failed` with reason `'session-terminal'` only if the session itself goes terminal before any boundary is reached |
| Agent-identity                    | Same as above                                                                                                                                                                               | Same as above, plus the `override`/resolved-`policyRef` name must be a key of the target `Bureau<D>`'s `agents` catalog                                                                                                                    | Step 0 of the session's next `bureau.run` call, never mid-run                                                                                 | Same as above                                                                                                                                                                            | Same as above                                                                                                                                           | Same per-target rule as above                                                                                                                                                                                          | Same as above, except the boundary it waits for is a future run's start                                                                                                                                                                                                                                    |
| Pause                             | `principal` authorized on the session                                                                                                                                                       | Session exists and is not terminal                                                                                                                                                                                                         | Entry of `runStep` (same point as row 1); the driver does not proceed into the step body past that point until a matching `resume` is applied | Synchronous accept; the session snapshot reports `paused: true` once applied                                                                                                             | Same typed outcomes as row 1                                                                                                                            | A second `pause` while one is already `accepted`/`applied` is idempotent, not a superseding event                                                                                                                      | `applied` at the boundary; `failed` with reason `'run-terminal'` if the targeted run aborts or completes while the pause is still `accepted`; pause does not carry into a future run                                                                                                                       |
| Resume                            | `principal` authorized on the session                                                                                                                                                       | Session exists and is not terminal                                                                                                                                                                                                         | Same per-step boundary                                                                                                                        | Synchronous accept; snapshot reports `paused: false` once applied                                                                                                                        | Same typed outcomes as row 1; a `resume` against a session that is not currently paused is accepted as a no-op, matching the idempotent-abort precedent | A second `resume` is idempotent                                                                                                                                                                                        | `applied` immediately if already at a boundary, otherwise at the next boundary; `failed` with `'run-terminal'` under the same condition as pause                                                                                                                                                           |

```ts
export interface SteeringDesiredState {
  readonly agentName?: string;
  readonly route?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly effort?: Effort;
  readonly paused: boolean;
  /** Increments by exactly one on every command that reaches `accepted`,
   *  whether or not it has been applied yet. Never decrements, never skips.
   *  This is the value `expectedRevision` above checks optimistic
   *  concurrency against. */
  readonly configVersion: number;
}

export interface SteeringEffectiveState extends SteeringDesiredState {
  /** The step index (loop.ts's `step`) whose boundary last consumed this
   *  state; identical numbering to AB-42's SessionInputPromotion.providerTurn. */
  readonly appliedAtStep: number;
  readonly appliedAtRunId: string;
  readonly appliedAt: string; // ISO
}
```

`SteeringDesiredState` is what a `SteeringCommand`, once `accepted`, writes into; `SteeringEffectiveState` is what the boundary reads out of it and stamps onto the step. They are two types, not one with an "is this applied yet" flag, because a caller inspecting desired state mid-flight must not be told a stale `appliedAtStep`. Both are exposed through the owning session's snapshot surface (AB-88's signature to build), never as a standalone locator.

```ts
export type SteeringCommandState =
  | 'requested' // received, not yet validated; exists only as the pre-admission moment, never persisted on its own
  | 'accepted' // validated, written into desired state, waiting for the next boundary
  | 'applied' // terminal-success: consumed at a step boundary, effective state stamped
  | 'rejected' // terminal-failure: invalidated post-admission (authorization revoked, policy denial)
  | 'superseded' // terminal-failure: a later command for the same target was admitted first
  | 'failed'; // terminal-failure: SteeringCommandFailure.reason is 'session-terminal' or, pause/resume only, 'run-terminal'
```

`requested` is not a state a `SteeringCommand` record is ever observed in: admission is synchronous validate-then-accept-or-reject, so nothing is persisted mid-request. **Supersession rationale.** AB-42 explicitly rejects automatic coalescing for conversational message content, because collapsing two messages can silently drop what a caller said. A `SteeringCommand` targeting `model`/`route`/etc. carries no content to drop; it is a desired value, and two commands for the same target are two different opinions about what that one value should be. Keeping both pending and racing them at the boundary has no coherent semantics, so this record decides last-request-per-target-wins, with the earlier one explicitly marked `superseded` (never silently dropped; it remains inspectable) rather than queued behind the new one or merged into it.

These seven exported types carry no runtime behavior on their own. The `runStep` boundary read, pause/resume gate, and `GenerateContext` threading ship (AB-198), as do the five `OperativeEventMap` events dispatched at these transitions (AB-90/AB-221): `steering.accepted`, `steering.applied`, `steering.rejected`, `steering.superseded`, `steering.failed`. `steering.applied` is dispatched by `runStep` itself, at the boundary above; the other four are exported for `submitSteeringCommand` (Bureau's admission surface, AB-199) to dispatch — `submitSteeringCommand` itself does not ship yet. No `steering.requested` event exists: the `requested` state is never persisted or dispatched standalone.

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
