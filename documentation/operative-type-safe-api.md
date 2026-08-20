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
 * public name for a run's validated output; `structuredOutput` is never
 * exposed anywhere in this API (today's operative `RunResult.structuredOutput`
 * is renamed as part of this contract, tracked by `AB-17`).
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

## Events

```ts
export type RunCompletedEvent<O = never, H extends boolean = false> = {
  result: RunResult<O, H>;
};
```

`RunCompletedEvent<O, H>` carries its payload as one nested `result` object —
not the flattened `conversation`/`steps`/`content`/`usage`/... properties
today's operative `RunCompletedEvent` class exposes directly. A listener reads
`event.result.output`, never `event.structuredOutput` or `event.output`
directly on the event. The runtime event's own `type: 'run.completed'`
discriminant comes from the `Event` base class it extends (as it does today),
not from this alias — this alias specifies only the new `result`-nested
payload shape.

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
```

The two `check-types` commands verify this documentation change didn't touch
runtime code — they are expected to pass unchanged, since this issue's
delivery boundary is decision content only. `AB-17`, `AB-18`, `AB-20`,
`AB-21`, and `AB-22` are where the actual type and runtime changes land,
verified against the contracts fixed here.
