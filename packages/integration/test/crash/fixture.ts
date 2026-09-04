/**
 * The crash-conformance child-process entry point (AB-270). Launched by
 * `harness.ts` via `Bun.spawn`, once per process generation, against a
 * shared SQLite backend path. Talks to the parent EXCLUSIVELY over
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
import { createBureauTestHarness, createSqliteStorageFixture } from 'bureau/test';
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
        return {
          content: '',
          toolCalls: [
            { id: 'crash-fixture-call-await-decision', name: 'await-decision', arguments: {} },
          ],
        };
      }
      default:
        // Reached only if `await-decision` ever answered `proceed` — this
        // scenario always cancels instead, so this branch is a defensive
        // fallback, never exercised by `sqlite.test.ts`.
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
  /**
   * Aborts the currently-running root run from WITHIN one of its own tool
   * calls. Fire-and-forget by design: `bureau.abortRun` is synchronous and
   * this tool call is itself part of the step being aborted, so waiting
   * HERE for the run to reach a terminal status would deadlock against its
   * own unwinding. `main()`'s own top-level poll (not this tool) is what
   * observes the terminal transition and reports `cancellation-recorded`.
   */
  readonly abortSelf: () => void;
}

function createFixtureToolbox(deps: FixtureToolDeps): AnyToolbox {
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
      const key = childKvKey(deps.rootRunId);
      const attemptId = `attempt-${crypto.randomUUID()}`;
      const claim = await deps.toolResultCache.claimStarted(`register-child:${key}`, {
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
        `register-child:${key}`,
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

  // `signal-parked`/`cancellation-recorded`: this tool call itself IS the
  // park — it blocks (one IPC round trip) exactly like every other marker
  // report, with no dependency on Weft's own workflow-suspend machinery.
  // Only ever answered `{ type: 'cancel' }` in `sqlite.test.ts` — this
  // scenario always drives the run to cancellation.
  const awaitDecision = createTool({
    name: 'await-decision',
    version: '1.0.0',
    description: 'Blocks until the parent harness decides whether to proceed or cancel this run.',
    input: z.object({}),
    async execute() {
      const command = await reportMarker('signal-parked', { runId: deps.rootRunId });
      if (command.type === 'cancel') {
        deps.abortSelf();
        return { decision: 'cancel' };
      }
      return { decision: 'proceed' };
    },
  });

  return createToolbox([registerChild, performEffect, awaitDecision]);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const NON_TERMINAL_STATUSES = new Set(['pending', 'running', 'suspended']);

type FixtureMode = 'primary' | 'recovery';

function parseMode(value: string | undefined): FixtureMode {
  if (value === 'primary' || value === 'recovery') return value;
  throw new Error(`crash fixture: usage: fixture.ts <sqlite-path> <primary|recovery> [rootRunId]`);
}

async function main(): Promise<void> {
  const [storagePath, modeArgument, existingRootRunId] = process.argv.slice(2);
  if (!storagePath) {
    throw new Error(
      'crash fixture: usage: fixture.ts <sqlite-path> <primary|recovery> [rootRunId]',
    );
  }
  const mode = parseMode(modeArgument);

  const runtime = createManualRuntimeServices();
  const storage = createSqliteStorageFixture({ runtime, path: storagePath });

  // `BureauOptions.toolbox` is fixed at construction, but this fixture's
  // real tools need `bureau.createRun`/`bureau.kv` — which do not exist
  // until construction resolves. Break the cycle with a mutable ref: the
  // toolbox is built FIRST, with tool bodies that close over `deps` and
  // read `deps.current` lazily — safe because no tool's `execute()` is
  // ever invoked before the first run starts, which is strictly after
  // `createBureauTestHarness` below resolves and populates the ref.
  let currentRootRunId = existingRootRunId ?? '';
  const deps: { current?: FixtureToolDeps } = {};
  // Every forwarded callback below fails fast — the SAME behavior for all
  // six — rather than some throwing and others silently no-opping when
  // called before `deps.current` is populated. A silent no-op here (e.g.
  // `registerDurableRun` dropping a run on the floor) would mask an
  // initialization-order bug as a missing quiescence registration instead
  // of a loud, immediate error.
  function requireDeps(): FixtureToolDeps {
    if (!deps.current) throw new Error('crash fixture: toolbox invoked before bureau was ready');
    return deps.current;
  }
  const fixtureToolbox = createFixtureToolbox({
    get rootRunId() {
      return currentRootRunId;
    },
    createChildRun: (message) => requireDeps().createChildRun(message),
    registerDurableRun: (runId) => requireDeps().registerDurableRun(runId),
    kvGet: (key) => requireDeps().kvGet(key),
    kvSet: (key, value) => requireDeps().kvSet(key, value),
    get toolResultCache() {
      return requireDeps().toolResultCache;
    },
    abortSelf: () => requireDeps().abortSelf(),
  });

  const generate = createFixtureGenerate();

  const harness = await createBureauTestHarness({
    agents: {},
    runtime,
    storage,
    // Without an explicit `stopWhen`, the low-level session/durable-run
    // loop (`createRun`, unlike `createAgent`) has NO default stop
    // condition and keeps calling `generate` until `maximumSteps` even
    // when a response carries no tool calls.
    stopWhen: stopWhen.noToolCalls(),
    generate,
    toolbox: fixtureToolbox,
  });

  const { bureau } = harness;
  if (!bureau.kv) {
    throw new Error('crash fixture: bureau.kv is unavailable — no durable KV composed');
  }
  const kv = bureau.kv;
  const toolResultCache = createToolResultCache({ store: kv, namespace: 'crash-fixture-cache' });
  deps.current = {
    rootRunId: '',
    async createChildRun(message: string) {
      const summary = await bureau.createRun({ message });
      return { id: summary.id, sessionId: summary.sessionId };
    },
    registerDurableRun: (runId) => harness.registerDurableRun(runId),
    kvGet: (key) => kv.get(key),
    kvSet: (key, value) => kv.set(key, value),
    toolResultCache,
    abortSelf: () => {
      if (currentRootRunId) bureau.abortRun(currentRootRunId);
    },
  };

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

  const rootState = currentRootRunId ? await bureau.getDurableRun(currentRootRunId) : null;
  const rootIsNonTerminal = !!rootState && NON_TERMINAL_STATUSES.has(rootState.status);

  if (rootIsNonTerminal) {
    // `signal-parked` and the cancellation it triggers both happen INSIDE
    // the `await-decision` tool call above (`createFixtureToolbox`) — this
    // is purely a bounded, macrotask-driven wait (never a real timer) for
    // that in-flight work to reach a terminal status before this driver
    // reports the outcome and moves on.
    await waitForCondition(
      async () => {
        const state = await bureau.getDurableRun(currentRootRunId);
        return !!state && !NON_TERMINAL_STATUSES.has(state.status);
      },
      `crash fixture: run "${currentRootRunId}" never reached a terminal status`,
      5000,
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
