/**
 * The crash-conformance child-process entry point (AB-270, extended to LMDB
 * by AB-335). Launched by `harness.ts` via `Bun.spawn`, once per process
 * generation, against a shared SQLite or LMDB backend path (`argv[2]` names
 * the path, `argv[3]` the backend). Talks to the parent EXCLUSIVELY over
 * structured line-delimited JSON on stdout (see `protocol.ts`); every log
 * line this file itself wants to leave for a human goes to stderr instead,
 * so stdout stays pure protocol.
 *
 * The fixture drives exactly one linear, deterministic scenario: a durable
 * root run registers a durable child run, performs one idempotency-guarded
 * external effect, parks awaiting the parent's decision, is cancelled, and
 * the bureau shuts down cleanly. Every `CrashMarker` (see `protocol.ts`) is
 * reported the instant its state transition happens, and the fixture BLOCKS
 * — awaiting exactly one line on stdin — after every marker, so the parent
 * controls pacing entirely: no marker here is ever inferred from timing, and
 * nothing in this file sleeps.
 *
 * Re-launched over the SAME backend path after a `SIGKILL`, this exact same
 * script runs again: Weft's boot recovery reattaches the still-in-flight
 * run (create-bureau.ts's `classifyRecoveredRun` `'reattach'` verdict) and
 * replays whichever step's `ctx.memo` had not yet committed, which
 * naturally re-invokes this file's own `generate`/tool callbacks and causes
 * them to re-report whatever marker they were interrupted at — there is no
 * separate "recovery mode" branch to keep in sync with the first-run path.
 *
 * AB-336: the `'signal-parked'` marker drives the REAL `requestHumanInput`
 * durable-park path (`BureauOptions.humanInput: true`), not a bespoke
 * blocking tool — AB-336 fixed the two things that made
 * `requestHumanInput` unusable here: the durable park itself was already
 * correct, but nothing surfaced it on the public liveness surface, and a
 * process recovered while still parked never reconstructed the pending
 * review from its checkpoint. Unlike the old `await-decision` tool, whose
 * `execute()` itself WAS the IPC block, `requestHumanInput`'s `execute()`
 * returns synchronously and the park happens afterward (post-loop) — so the
 * marker report and parent round-trip happen at the DRIVER level in
 * `main()`, not inside a tool, watching `bureau.listPendingReviews()` for
 * the human-wait review this run's park produces. That surface is exactly
 * what AB-336 made recovery-safe: a process that reattaches a run already
 * parked when this fixture killed the prior one sees the SAME review,
 * reconstructed from the checkpoint rather than lost with the dead
 * process's in-memory action log.
 */
import type {
  AnyToolbox,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
} from '@lostgradient/operative';
import { stopWhen } from '@lostgradient/operative';
import { createManualRuntimeServices, waitForCondition } from '@lostgradient/operative/test';
import { createTool, createToolbox, createToolResultCache, type ToolResultCache } from 'armorer';
import type { PendingReview } from 'bureau';
import {
  createBureauTestHarness,
  createLmdbStorageFixture,
  createSqliteStorageFixture,
} from 'bureau/test';
import { z } from 'zod';

import {
  type CrashFixtureMessage,
  type CrashMarker,
  type CrashParentCommand,
  decodeCrashParentCommand,
  encodeCrashLine,
  type JsonValue,
} from './protocol';

const CHILD_MESSAGE_PREFIX = 'crash-fixture-child-of:';
/** The signal name every `requestHumanInput` call in this fixture parks on. */
const CRASH_DECISION_SIGNAL_NAME = 'crash-fixture-decision';

function childKvKey(rootRunId: string): string {
  return `crash-fixture:child:${rootRunId}`;
}
function effectKvKey(rootRunId: string): string {
  return `crash-fixture:effect:${rootRunId}`;
}
function effectCountKvKey(rootRunId: string): string {
  return `crash-fixture:effect-count:${rootRunId}`;
}

// ---------------------------------------------------------------------------
// stdout/stdin protocol plumbing
// ---------------------------------------------------------------------------

function writeLine(message: CrashFixtureMessage): void {
  process.stdout.write(`${encodeCrashLine(message)}\n`);
}

/** A single shared line reader over stdin — every marker report consumes exactly one line from it. */
class StdinLineReader {
  private readonly pending: string[] = [];
  private buffer = '';
  private resolveWaiting: (() => void) | undefined;

  constructor() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim().length > 0) this.pending.push(line);
        index = this.buffer.indexOf('\n');
      }
      if (this.pending.length > 0 && this.resolveWaiting) {
        const resolve = this.resolveWaiting;
        this.resolveWaiting = undefined;
        resolve();
      }
    });
  }

  async nextLine(): Promise<string> {
    while (this.pending.length === 0) {
      await new Promise<void>((resolve) => {
        this.resolveWaiting = resolve;
      });
    }
    const line = this.pending.shift();
    if (line === undefined) throw new Error('crash fixture: line reader woke with nothing pending');
    return line;
  }

  async nextCommand(): Promise<CrashParentCommand> {
    return decodeCrashParentCommand(await this.nextLine());
  }
}

const stdin = new StdinLineReader();

/**
 * Serializes every marker report behind one lock: two concurrent callers
 * (a background wait-for-park poll racing the step-execution chain) must
 * never interleave a stdout write with a stdin read meant for a different
 * marker.
 */
let reportLock: Promise<unknown> = Promise.resolve();

function reportMarker(
  marker: CrashMarker,
  detail?: Record<string, JsonValue>,
): Promise<CrashParentCommand> {
  const task = reportLock.then(async () => {
    writeLine({ type: 'marker', marker, ...(detail ? { detail } : {}) });
    return stdin.nextCommand();
  });
  reportLock = task.catch(() => undefined);
  return task;
}

function reportObservation(label: string, value: JsonValue): void {
  writeLine({ type: 'observation', label, value });
}

// ---------------------------------------------------------------------------
// The scripted, replay-safe generate function and toolbox
// ---------------------------------------------------------------------------

function firstUserMessageText(context: GenerateContext): string {
  const messages = context.conversation.getMessages();
  const first = messages.find((message) => message.role === 'user');
  if (!first) return '';
  return typeof first.content === 'string' ? first.content : '';
}

function isChildRun(context: GenerateContext): boolean {
  return firstUserMessageText(context).startsWith(CHILD_MESSAGE_PREFIX);
}

/** Strips a value down to plain JSON (dropping `undefined`s, functions, etc.) before it crosses the IPC boundary. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/**
 * The bureau-level `generate` function for BOTH the root run and every
 * child run this fixture starts — Bureau composes exactly one `generate`
 * per bureau, so the two scripts are distinguished by the run's own first
 * user message (`isChildRun`), never by process-local state (state would
 * not survive replay).
 */
function createFixtureGenerate(): GenerateFunction {
  return async (context: GenerateContext): Promise<GenerateResponse> => {
    if (isChildRun(context)) {
      // The child run has one job: finish immediately, with no tool calls,
      // so `register-child`'s dispatch settles fast and durably.
      return { content: 'crash-fixture child done', toolCalls: [] };
    }

    switch (context.step) {
      case 0:
        return {
          content: '',
          toolCalls: [
            { id: 'crash-fixture-call-register-child', name: 'register-child', arguments: {} },
          ],
        };
      case 1:
        return {
          content: '',
          toolCalls: [
            { id: 'crash-fixture-call-perform-effect', name: 'perform-effect', arguments: {} },
          ],
        };
      case 2: {
        // Both prior steps are durably checkpointed by the time Weft calls
        // `generate` for the NEXT step (`run-workflow.ts`'s per-step
        // `ctx.memo` — a step's memo only resolves, letting the workflow
        // advance, once everything inside it, generate call and tool
        // execution alike, has completed and been persisted).
        await reportMarker('checkpoint-committed', { step: context.step });
        // AB-336: the REAL durable-park tool, wired in automatically by
        // `BureauOptions.humanInput: true` — `execute()` returns
        // synchronously (it only records the park request; the actual
        // `ctx.waitForSignal` park happens post-loop), so `signal-parked`
        // is reported and resolved from `main()`'s own driver loop, not
        // from inside this tool. See this file's top comment.
        return {
          content: '',
          toolCalls: [
            {
              id: 'crash-fixture-call-request-human-input',
              name: 'requestHumanInput',
              arguments: { signalName: CRASH_DECISION_SIGNAL_NAME },
            },
          ],
        };
      }
      default:
        // Reached only if the parent's decision ever resolved `proceed` —
        // this scenario always cancels instead, so this branch is a
        // defensive fallback, never exercised by `sqlite.test.ts`.
        return { content: 'crash-fixture done', toolCalls: [] };
    }
  };
}

interface FixtureToolDeps {
  readonly rootRunId: string;
  readonly createChildRun: (message: string) => Promise<{ id: string; sessionId: string }>;
  readonly registerDurableRun: (runId: string) => void;
  readonly kvGet: (key: string) => Promise<string | null>;
  readonly kvSet: (key: string, value: string) => Promise<void>;
  readonly toolResultCache: ToolResultCache;
}

function createFixtureToolbox(getDeps: () => Promise<FixtureToolDeps>): AnyToolbox {
  // `register-child` dispatches `bureau.createRun` — an effect with no
  // caller-supplied idempotency key of its own — so it is guarded by the
  // SAME idempotency-cache pattern as `perform-effect` below: without this,
  // a kill mid-step (before the step's `ctx.memo` commits) would replay the
  // WHOLE step on recovery, including this dispatch, minting a genuinely
  // SECOND child run rather than recovering the first one's identity.
  const registerChild = createTool({
    name: 'register-child',
    version: '1.0.0',
    description: 'Dispatches a durable child run and records its identity, exactly once.',
    input: z.object({}),
    async execute() {
      // AB-335: awaits real dependencies rather than throwing when they are
      // not yet wired — see this file's `getDeps()` comment in `main()`.
      const deps = await getDeps();
      const key = childKvKey(deps.rootRunId);
      const attemptId = `attempt-${crypto.randomUUID()}`;
      const cacheKey = `register-child:${key}`;
      const claim = await deps.toolResultCache.claimStarted(cacheKey, {
        status: 'started',
        toolName: 'register-child',
        startedAt: Date.now(),
        ttl: 0,
        attemptId,
      });

      if (claim.outcome === 'existing') {
        const entry = claim.entry;
        if (entry.status !== 'started') {
          throw new Error(
            'crash fixture: register-child observed an already-completed idempotency ' +
              'entry on what should be its first live attempt this process generation',
          );
        }
        // A prior process's attempt claimed this key and never completed it
        // — the child run it may or may not have started is unresolved.
        // Never dispatch a second child to "recover" it.
        await reportMarker('child-registered', {
          duplicateAttempt: true,
          priorAttemptId: entry.attemptId ?? null,
        });
        return { status: 'unresolved-prior-attempt', attemptId: entry.attemptId ?? null };
      }

      const child = await deps.createChildRun(`${CHILD_MESSAGE_PREFIX}${deps.rootRunId}`);
      deps.registerDurableRun(child.id);
      await deps.kvSet(key, JSON.stringify({ childRunId: child.id, parentRunId: deps.rootRunId }));

      // Only ever `{ type: 'proceed' }` at this marker in `sqlite.test.ts`.
      await reportMarker('child-registered', { childRunId: child.id, parentRunId: deps.rootRunId });

      await deps.toolResultCache.completeStarted(
        cacheKey,
        attemptId,
        {
          status: 'completed',
          result: { childRunId: child.id },
          toolName: 'register-child',
          executedAt: Date.now(),
          ttl: 0,
        },
        0,
      );
      return { registered: true, childRunId: child.id };
    },
  });

  const performEffect = createTool({
    name: 'perform-effect',
    version: '1.0.0',
    description: 'Performs one idempotency-guarded external effect exactly once.',
    input: z.object({}),
    async execute() {
      // AB-335: awaits real dependencies rather than throwing when they are
      // not yet wired — see this file's `getDeps()` comment in `main()`.
      const deps = await getDeps();
      const key = effectKvKey(deps.rootRunId);
      const attemptId = `attempt-${crypto.randomUUID()}`;
      const claim = await deps.toolResultCache.claimStarted(key, {
        status: 'started',
        toolName: 'perform-effect',
        startedAt: Date.now(),
        ttl: 0,
        attemptId,
      });

      if (claim.outcome === 'existing') {
        const entry = claim.entry;
        if (entry.status !== 'started') {
          // Weft's per-step memo never re-invokes a step whose result was
          // already checkpointed, so a completed cache entry can never be
          // observed by a fresh attempt at this same tool call.
          throw new Error(
            'crash fixture: perform-effect observed an already-completed idempotency ' +
              'entry on what should be its first live attempt this process generation',
          );
        }
        // A prior process's attempt claimed this key and never completed it
        // (an "effect-attempted" kill). Per armorer's idempotency contract,
        // an unresolved started marker is NEVER silently retried and NEVER
        // reported as rolled back — it is surfaced as-is.
        await reportMarker('effect-attempted', {
          duplicateAttempt: true,
          priorAttemptId: entry.attemptId ?? null,
        });
        return { status: 'unresolved-prior-attempt', attemptId: entry.attemptId ?? null };
      }

      const countRaw = await deps.kvGet(effectCountKvKey(deps.rootRunId));
      const nextCount = (countRaw ? Number.parseInt(countRaw, 10) : 0) + 1;
      await deps.kvSet(effectCountKvKey(deps.rootRunId), String(nextCount));

      // Only ever `{ type: 'proceed' }` at this marker in `sqlite.test.ts` —
      // the kill target for the "effect-attempted" scenario lands exactly
      // here, between the effect above and `completeStarted` below.
      await reportMarker('effect-attempted', { attemptId, effectCount: nextCount });

      await deps.toolResultCache.completeStarted(
        key,
        attemptId,
        {
          status: 'completed',
          result: { ok: true, effectCount: nextCount },
          toolName: 'perform-effect',
          executedAt: Date.now(),
          ttl: 0,
        },
        0,
      );
      return { status: 'completed', effectCount: nextCount };
    },
  });

  // AB-336: `signal-parked` is now the REAL `requestHumanInput` durable
  // park (`BureauOptions.humanInput: true` wires that tool in
  // automatically) — no bespoke blocking tool needed here. See this file's
  // top comment and the park-wait block in `main()` below.
  return createToolbox([registerChild, performEffect]);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const NON_TERMINAL_STATUSES = new Set(['pending', 'running', 'suspended']);

/**
 * AB-271/AB-335: a real (tiny) per-iteration delay for `waitForCondition`'s
 * `yieldTurn` parameter, in place of its default zero-delay `MessageChannel`
 * macrotask (`yieldToPortableEventLoop`). Root-caused directly (AB-306,
 * `packages/bureau/src/test/harness-lmdb-isolation.test.ts`'s
 * `waitForRunCompletion`): a tight zero-delay macrotask loop is scheduled
 * AHEAD of `lmdb`'s own native write-completion callback, so a pending write
 * the loop is waiting to observe never lands while the loop spins. This
 * mirrors that already-established, already-merged mitigation rather than
 * inventing a new one — WFT-138 (Backlog) tracks the actual production fix
 * (a test-mode `noSync`/`noMetaSync` LMDBStorage option); once it lands this
 * real-delay yield can be dropped for the default one everywhere in this
 * file. Still a bounded, condition-checked poll — never a blind sleep.
 */
function realDelayYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

type FixtureMode = 'primary' | 'recovery';
type FixtureBackend = 'sqlite' | 'lmdb';

const USAGE =
  'crash fixture: usage: fixture.ts <storage-path> <sqlite|lmdb> <primary|recovery> [rootRunId]';

function parseMode(value: string | undefined): FixtureMode {
  if (value === 'primary' || value === 'recovery') return value;
  throw new Error(USAGE);
}

function parseBackend(value: string | undefined): FixtureBackend {
  if (value === 'sqlite' || value === 'lmdb') return value;
  throw new Error(USAGE);
}

async function main(): Promise<void> {
  const [storagePath, backendArgument, modeArgument, existingRootRunId] = process.argv.slice(2);
  if (!storagePath) {
    throw new Error(USAGE);
  }
  const backend = parseBackend(backendArgument);
  const mode = parseMode(modeArgument);

  const runtime = createManualRuntimeServices();
  const storage =
    backend === 'lmdb'
      ? createLmdbStorageFixture({ runtime, path: storagePath })
      : createSqliteStorageFixture({ runtime, path: storagePath });

  // `BureauOptions.toolbox` is fixed at construction, but this fixture's
  // real tools need `bureau.createRun`/`bureau.kv` — which do not exist
  // until construction resolves. Break the cycle with a DEFERRED PROMISE,
  // not a throw-if-unset ref (AB-335's own root cause — see below): the
  // toolbox is built FIRST, with tool bodies that `await getDeps()`,
  // resolved once `createBureauTestHarness` below resolves and the real
  // deps are ready.
  //
  // AB-335: this file's own prior version used a mutable ref (`deps: {
  // current?: FixtureToolDeps }`) with a `requireDeps()` that THREW
  // immediately when a tool fired before the ref was populated, on the
  // stated assumption that "no tool's `execute()` is ever invoked before
  // the first run starts, which is strictly after `createBureauTestHarness`
  // resolves." That assumption is false for a RECOVERED run:
  // `create-bureau.ts`'s own boot-recovery doc comment is explicit that
  // "Boot returns once `recoverAll()` has STARTED the handles and they are
  // registered, not when they complete" — a recovered run's first step
  // (generate + tool dispatch) can already be in flight before
  // `createBureauTestHarness`'s promise resolves. Root-caused directly by
  // instrumenting `generate`'s entry: over the LMDB backend the recovered
  // process's SECOND `generate` call (step 1) showed a conversation already
  // carrying a `tool-result` for `register-child` with
  // `outcome: 'error'`, `message: 'crash fixture: toolbox invoked before
  // bureau was ready'` — the OLD `requireDeps()` throw, fired by boot
  // recovery's own eager tool dispatch, racing this file's post-construction
  // `deps.current = {...}` assignment below. Weft's per-step memo then
  // durably checkpoints that ERROR as step 0's final result, so replay never
  // re-invokes `register-child` again — armorer's `claimStarted` is never
  // even reached on the recovered process. LMDB's faster, more synchronous
  // recovery path wins this race consistently (10/10 observed); SQLite's
  // slower path consistently loses it, which is why this scenario has
  // passed on SQLite. The fix is not a retry — the coordinator ruling
  // (AB-335) explicitly forbids that — it removes the race: every tool body
  // now correctly WAITS for its real dependencies instead of treating "not
  // yet ready" as a terminal error.
  let currentRootRunId = existingRootRunId ?? '';
  // `rootRunId` is deliberately NOT captured inside `restOfDepsPromise`'s
  // resolved value: in primary mode it is only assigned (below) strictly
  // AFTER `restOfDepsPromise` resolves, so `getDeps()` must re-read
  // `currentRootRunId` live, on every call, the same way the old getter did.
  let resolveRestOfDeps!: (deps: Omit<FixtureToolDeps, 'rootRunId'>) => void;
  const restOfDepsPromise = new Promise<Omit<FixtureToolDeps, 'rootRunId'>>((resolve) => {
    resolveRestOfDeps = resolve;
  });
  async function getDeps(): Promise<FixtureToolDeps> {
    const rest = await restOfDepsPromise;
    return { ...rest, rootRunId: currentRootRunId };
  }
  const fixtureToolbox = createFixtureToolbox(getDeps);

  const generate = createFixtureGenerate();

  const harness = await createBureauTestHarness({
    agents: {},
    runtime,
    storage,
    // Without an explicit `stopWhen`, the low-level session/durable-run
    // loop (`createRun`, unlike `createAgent`) has NO default stop
    // condition and keeps calling `generate` until `maximumSteps` even
    // when a response carries no tool calls. Deliberately NOT
    // `stopWhen.toolCalled('requestHumanInput')` — the durable park itself
    // (AB-44/AB-45) must break the step loop on its own; a `stopWhen` that
    // matched the call would mask whether it does.
    stopWhen: stopWhen.noToolCalls(),
    generate,
    toolbox: fixtureToolbox,
    // AB-336: wires the real `requestHumanInput` tool into every run this
    // bureau starts (durable-only; a no-op guard inside bureau itself for
    // any non-durable run, none of which this fixture ever creates).
    humanInput: true,
  });

  const { bureau } = harness;
  if (!bureau.kv) {
    throw new Error('crash fixture: bureau.kv is unavailable — no durable KV composed');
  }
  const kv = bureau.kv;
  const toolResultCache = createToolResultCache({ store: kv, namespace: 'crash-fixture-cache' });
  resolveRestOfDeps({
    async createChildRun(message: string) {
      const summary = await bureau.createRun({ message });
      return { id: summary.id, sessionId: summary.sessionId };
    },
    registerDurableRun: (runId) => harness.registerDurableRun(runId),
    kvGet: (key) => kv.get(key),
    kvSet: (key, value) => kv.set(key, value),
    toolResultCache,
  });

  await reportMarker('ready');

  if (mode === 'primary') {
    const summary = await bureau.createRun({ message: 'crash-fixture-root' });
    currentRootRunId = summary.id;
    harness.registerDurableRun(summary.id);
    await reportMarker('run-started', { runId: summary.id, sessionId: summary.sessionId });
  } else if (currentRootRunId) {
    harness.registerDurableRun(currentRootRunId);
    reportObservation('resumed-root-run-id', currentRootRunId);
  } else {
    // Recovering after a kill at `ready` (or earlier): no run was ever
    // durably started, so there is nothing to reattach — go straight to
    // the terminal-state assertions below, all of which already treat an
    // empty `currentRootRunId` as "nothing to look up."
    reportObservation('resumed-root-run-id', null);
  }

  // AB-335: no retry here, per the coordinator ruling. In primary mode the
  // root run was minted one line above, in THIS process, and this fixture's
  // own `generate` always returns a tool call at step 0 — `stopWhen` cannot
  // have stopped it yet, so it is known non-terminal without a storage read
  // at all. Recovery mode reads exactly once and returns whatever it
  // observes, including `null`/`undefined`, as a genuine observation.
  const rootState =
    mode === 'recovery' && currentRootRunId ? await bureau.getDurableRun(currentRootRunId) : null;
  let rootIsNonTerminal =
    mode === 'primary' ? true : !!rootState && NON_TERMINAL_STATUSES.has(rootState.status);

  if (rootIsNonTerminal) {
    // AB-336: `requestHumanInput`'s `execute()` returns synchronously — the
    // actual `ctx.waitForSignal` park happens post-loop, so unlike the old
    // `await-decision` tool (whose `execute()` itself WAS the IPC block),
    // the marker report and parent round-trip happen HERE, driver-side,
    // watching for the human-wait review the park produces. This bounded,
    // macrotask-driven wait (never a real timer) also covers the run
    // settling to terminal without ever parking — not reachable through
    // this fixture's own linear flow, but never assumed away.
    //
    // `listPendingReviews()` is exactly what AB-336 made recovery-safe: a
    // process that reattaches this run already parked when the prior one
    // was killed sees the SAME review, reconstructed from the checkpoint —
    // not lost with the dead process's in-memory action log.
    let humanWaitReview: PendingReview | undefined;
    await waitForCondition(
      async () => {
        humanWaitReview = bureau
          .listPendingReviews()
          .find((review) => review.runId === currentRootRunId && review.kind === 'human-wait');
        if (humanWaitReview) return true;
        const state = await bureau.getDurableRun(currentRootRunId);
        return !state || !NON_TERMINAL_STATUSES.has(state.status);
      },
      `crash fixture: run "${currentRootRunId}" neither parked on requestHumanInput nor reached a terminal status`,
      backend === 'lmdb' ? 400 : 5000,
      backend === 'lmdb' ? realDelayYield : undefined,
    );

    if (humanWaitReview) {
      // Only ever answered `{ type: 'cancel' }` in `sqlite.test.ts` — this
      // scenario always drives the run to cancellation — except for the
      // scenario configured to kill exactly at this marker, which never
      // reaches this `if`: the harness SIGKILLs the moment the marker line
      // is written, with no answer sent (see `harness.ts`).
      const command = await reportMarker('signal-parked', { runId: currentRootRunId });
      if (command.type === 'cancel') {
        bureau.abortRun(currentRootRunId);
      } else {
        // AB-44: approving continues the SAME run with one more generation
        // step — never a bare unpark. `createFixtureGenerate`'s `default`
        // branch is what that continuation step reaches.
        await bureau.resolveReview({
          id: humanWaitReview.id,
          decision: 'approve',
          principal: 'crash-fixture',
        });
      }

      const stateAfterDecision = await bureau.getDurableRun(currentRootRunId);
      rootIsNonTerminal =
        !!stateAfterDecision && NON_TERMINAL_STATUSES.has(stateAfterDecision.status);
    }
  }

  if (rootIsNonTerminal) {
    await waitForCondition(
      async () => {
        const state = await bureau.getDurableRun(currentRootRunId);
        return !!state && !NON_TERMINAL_STATUSES.has(state.status);
      },
      `crash fixture: run "${currentRootRunId}" never reached a terminal status`,
      backend === 'lmdb' ? 400 : 5000,
      backend === 'lmdb' ? realDelayYield : undefined,
    );
    await reportMarker('cancellation-recorded', { runId: currentRootRunId });
  }

  const finalRootState = currentRootRunId ? await bureau.getDurableRun(currentRootRunId) : null;
  reportObservation('final-root-workflow-state', toJson(finalRootState));

  const childRaw = currentRootRunId ? await kv.get(childKvKey(currentRootRunId)) : null;
  reportObservation('child-record', childRaw ? toJson(JSON.parse(childRaw)) : null);

  // Read through the SAME `ToolResultCache` API the tool itself uses
  // (`toolResultCache.getState`), not a raw `kv.get` — the cache applies
  // its own key namespace, so reading the raw key directly would silently
  // miss the entry.
  const effectCacheEntry = currentRootRunId
    ? await toolResultCache.getState(effectKvKey(currentRootRunId))
    : undefined;
  reportObservation('effect-cache-entry', effectCacheEntry ? toJson(effectCacheEntry) : null);

  const effectCountRaw = currentRootRunId ? await kv.get(effectCountKvKey(currentRootRunId)) : null;
  reportObservation('effect-count', effectCountRaw ?? null);

  const report = await harness.close();
  reportObservation('shutdown-report', toJson(report.shutdownReport));
  reportObservation('quiescent', report.quiescent);

  await reportMarker('cleanup-completed', { quiescent: report.quiescent });

  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  try {
    writeLine({ type: 'fatal', message, ...(stack ? { stack } : {}) });
  } catch {
    // stdout may already be gone (e.g. the parent closed the pipe) — stderr
    // is the last-resort record either way.
  }
  console.error(error);
  process.exit(1);
});
