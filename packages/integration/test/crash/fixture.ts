/**
 * The crash-conformance child-process entry point (AB-270, extended to LMDB
 * by AB-335). Launched by `harness.ts` via `Bun.spawn`, once per process
 * generation, against a shared SQLite or LMDB backend path (`argv[2]` names
 * the path, `argv[3]` the backend). Talks to the parent EXCLUSIVELY over
 * structured line-delimited JSON on stdout (see `protocol.ts`); every log
 * line this file itself wants to leave for a human goes to stderr instead,
 * so stdout stays pure protocol.
 *
 * The fixture drives one of four scripted, deterministic scenarios, named
 * by `argv[4]` (`CrashScenarioKind`, see `harness.ts`): `'linear'` (AB-270's
 * original) — a durable root run registers a durable child run, performs
 * one idempotency-guarded external effect, parks awaiting the parent's
 * decision, is cancelled, and the bureau shuts down cleanly; AB-271's three
 * harder scripts (`'nested-children'`, `'schedule-fire'`, and
 * `'recovery-failure'`) replace or extend individual steps of that same
 * shape — see `createFixtureGenerate`'s per-kind branches and `main()`'s
 * `kind === 'recovery-failure'` branch for the one kind with a genuinely
 * different driver path. Every `CrashMarker` (see `protocol.ts`) is
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
 *
 * AB-275: an optional fifth argv flag (`--gateway`) additionally starts a
 * REAL `Gateway` (a real `Bun.serve` loopback listener on an
 * operating-system-assigned ephemeral port) over the SAME bureau this
 * fixture already builds, sharing this file's own `ManualRuntimeServices`
 * the same way `packages/gateway/src/test/loopback.ts` does. The bound
 * port is reported in the `'ready'` marker's own `detail` — no new marker
 * is needed, since `'ready'` already fires once the gateway (when enabled)
 * has started, and `CrashFixtureMessage`'s `detail` bag already accepts an
 * arbitrary JSON record. `sqlite.test.ts`'s existing bureau-only scenario
 * never passes `--gateway`, so it is completely unaffected.
 */
import type {
  AnyToolbox,
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
} from '@lostgradient/operative';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { createManualRuntimeServices, waitForCondition } from '@lostgradient/operative/test';
import { createTool, createToolbox, createToolResultCache, type ToolResultCache } from 'armorer';
import type { AgentDefinitions, PendingReview } from 'bureau';
import {
  createBureauTestHarness,
  createLmdbStorageFixture,
  createSqliteStorageFixture,
} from 'bureau/test';
import { createGateway, type Gateway } from 'gateway';
import { z } from 'zod';

import type { CrashScenarioKind } from './harness';
import {
  CRASH_FIXTURE_GATEWAY_AUTH_TOKEN,
  type CrashFixtureMessage,
  type CrashMarker,
  type CrashParentCommand,
  decodeCrashParentCommand,
  encodeCrashLine,
  type JsonValue,
} from './protocol';

const CHILD_MESSAGE_PREFIX = 'crash-fixture-child-of:';
/** The name recorded in `agents` for the AB-29 recovery-failure scenario's catalog run — present only in primary mode. */
const GHOST_AGENT_NAME = 'crash-fixture-ghost-agent';

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
/** One record per nested child (index 0 or 1) — same shape as `childKvKey`'s single-child record. */
function nestedChildKvKey(rootRunId: string, index: number): string {
  return `crash-fixture:nested-child:${rootRunId}:${index}`;
}
function scheduleKvKey(rootRunId: string): string {
  return `crash-fixture:schedule:${rootRunId}`;
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
/** AB-336's real durable-park tool call — shared by every kind's final step. */
function requestHumanInputStep(): GenerateResponse {
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

/**
 * The bureau-level `generate` function for BOTH the root run and every child
 * run this fixture starts, branched by `kind` (AB-271). `'linear'` is
 * AB-270's original script; the other kinds each replace or extend one step
 * while reusing the same final requestHumanInput/cancel tail so the existing
 * signal-parked/cancellation-recorded marker matrix (and `main()`'s driver
 * loop below) keeps working unmodified for every kind.
 */
function createFixtureGenerate(kind: CrashScenarioKind): GenerateFunction {
  return async (context: GenerateContext): Promise<GenerateResponse> => {
    if (isChildRun(context)) {
      if (kind === 'nested-children') {
        // A nested child must still be LIVE (non-terminal) at the parent's
        // kill point, so it parks on the SAME durable requestHumanInput
        // primitive the root uses, rather than finishing immediately —
        // nothing in this fixture ever resolves a child's own review; the
        // cascade-abort path in `main()` terminates it instead.
        if (context.step === 0) return requestHumanInputStep();
        return { content: 'crash-fixture child done', toolCalls: [] };
      }
      // Every other kind's child has one job: finish immediately, with no
      // tool calls, so `register-child`'s dispatch settles fast and durably.
      return { content: 'crash-fixture child done', toolCalls: [] };
    }

    if (kind === 'nested-children') {
      switch (context.step) {
        case 0:
          return {
            content: '',
            toolCalls: [
              {
                id: 'crash-fixture-call-register-children',
                name: 'register-children',
                arguments: {},
              },
            ],
          };
        case 1:
          return requestHumanInputStep();
        default:
          return { content: 'crash-fixture done', toolCalls: [] };
      }
    }

    if (kind === 'schedule-fire') {
      switch (context.step) {
        case 0:
          return {
            content: '',
            toolCalls: [
              {
                id: 'crash-fixture-call-register-schedule',
                name: 'register-schedule',
                arguments: {},
              },
            ],
          };
        case 1:
          return {
            content: '',
            toolCalls: [
              { id: 'crash-fixture-call-perform-effect', name: 'perform-effect', arguments: {} },
            ],
          };
        case 2:
          await reportMarker('checkpoint-committed', { step: context.step });
          return requestHumanInputStep();
        default:
          return { content: 'crash-fixture done', toolCalls: [] };
      }
    }

    // 'linear' (AB-270's original scenario) and the bureau-level generate
    // 'recovery-failure' composes but never actually drives (that kind
    // dispatches through `harness.startRun`'s catalog path instead — see
    // `main()`).
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
        return requestHumanInputStep();
      }
      default:
        // Reached only when the parent's decision resolves `proceed`
        // (the signal-resume scenario) — the base linear scenario always
        // cancels instead, so this branch is exercised only by that one.
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
  /** AB-271 schedule-fire scenario only: `bureau.createSchedule`, bound with a fixed definition. */
  readonly createSchedule: () => Promise<{ id: string }>;
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

  // AB-271: `register-children` is `register-child` generalized to TWO
  // children, each guarded by its own idempotency-cache entry
  // (`nestedChildKvKey(rootRunId, index)`) — a kill mid-registration
  // replays the step and recovers each slot independently, exactly the
  // same single-child mechanism `register-child` above already proves,
  // just applied twice so neither child is ever silently dropped nor
  // double-dispatched.
  const registerChildren = createTool({
    name: 'register-children',
    version: '1.0.0',
    description:
      'Dispatches two durable child runs and records their identities, exactly once each.',
    input: z.object({}),
    async execute() {
      const deps = await getDeps();
      // Two passes, like `register-child`'s single dispatch: everything that
      // must be idempotency-guarded (claim, dispatch, KV write) happens
      // FIRST, the marker is reported ONLY AFTER both children are
      // dispatched (so `killAtMarker: 'children-registered'` always lands
      // with the idempotency-cache entries still `'started'`, never
      // `'completed'`), and `completeStarted` runs LAST — mirroring
      // `register-child`'s own dispatch → report → complete ordering so a
      // kill at this marker replays into "existing, started" on every slot
      // that had already dispatched, never "existing, completed".
      const pending: Array<{
        index: number;
        childRunId: string;
        duplicateAttempt: boolean;
        cacheKey?: string;
        attemptId?: string;
      }> = [];
      for (let index = 0; index < 2; index += 1) {
        const key = nestedChildKvKey(deps.rootRunId, index);
        const attemptId = `attempt-${crypto.randomUUID()}`;
        const cacheKey = `register-children:${key}`;
        const claim = await deps.toolResultCache.claimStarted(cacheKey, {
          status: 'started',
          toolName: 'register-children',
          startedAt: Date.now(),
          ttl: 0,
          attemptId,
        });

        if (claim.outcome === 'existing') {
          const entry = claim.entry;
          if (entry.status !== 'started') {
            throw new Error(
              'crash fixture: register-children observed an already-completed idempotency ' +
                'entry on what should be its first live attempt this process generation',
            );
          }
          const raw = await deps.kvGet(key);
          const record = raw ? (JSON.parse(raw) as { childRunId: string }) : undefined;
          pending.push({ index, childRunId: record?.childRunId ?? '', duplicateAttempt: true });
          continue;
        }

        const child = await deps.createChildRun(
          `${CHILD_MESSAGE_PREFIX}${deps.rootRunId}:${index}`,
        );
        deps.registerDurableRun(child.id);
        await deps.kvSet(
          key,
          JSON.stringify({ childRunId: child.id, parentRunId: deps.rootRunId, index }),
        );
        pending.push({ index, childRunId: child.id, duplicateAttempt: false, cacheKey, attemptId });
      }

      // Only ever `{ type: 'proceed' }` in `scenarios.ts` — this scenario
      // never kills exactly here twice, so the command is never observed.
      await reportMarker('children-registered', {
        children: pending.map(({ index, childRunId, duplicateAttempt }) => ({
          index,
          childRunId,
          duplicateAttempt,
        })),
      });

      for (const entry of pending) {
        if (!entry.cacheKey || !entry.attemptId) continue; // a duplicate-attempt slot has nothing to complete
        await deps.toolResultCache.completeStarted(
          entry.cacheKey,
          entry.attemptId,
          {
            status: 'completed',
            result: { childRunId: entry.childRunId },
            toolName: 'register-children',
            executedAt: Date.now(),
            ttl: 0,
          },
          0,
        );
      }

      return { registered: true, children: pending };
    },
  });

  // AB-271: registers the recurring schedule definition ONLY — this tool
  // does not drive a fire, and does not perform any effect of its own. Its
  // one job is proving the DEFINITION survives a crash, read back via
  // `bureau.getSchedule` in `main()` below. The root run's separate
  // `perform-effect` step (unrelated to this schedule) is what re-proves
  // the existing exactly-once idempotency guarantee for this scenario;
  // this comment used to (incorrectly) describe that step as belonging to
  // "the fire's own effect" — there is no fire here. Bureau's recurring
  // poller cannot be driven deterministically through any public surface
  // (WFT-141 — verified directly: `bureau.runDurableMaintenance` does not
  // fire a `createSchedule`-registered schedule), so this scenario proves
  // only definition-survival, not fire-recovery; see `scenarios.ts`'s
  // matching scenario for the honest scope of what this covers.
  const registerSchedule = createTool({
    name: 'register-schedule',
    version: '1.0.0',
    description:
      'Registers the recurring schedule definition this scenario proves survives a crash.',
    input: z.object({}),
    async execute() {
      const deps = await getDeps();
      const key = scheduleKvKey(deps.rootRunId);
      const attemptId = `attempt-${crypto.randomUUID()}`;
      const cacheKey = `register-schedule:${key}`;
      const claim = await deps.toolResultCache.claimStarted(cacheKey, {
        status: 'started',
        toolName: 'register-schedule',
        startedAt: Date.now(),
        ttl: 0,
        attemptId,
      });

      if (claim.outcome === 'existing') {
        const entry = claim.entry;
        if (entry.status !== 'started') {
          throw new Error(
            'crash fixture: register-schedule observed an already-completed idempotency ' +
              'entry on what should be its first live attempt this process generation',
          );
        }
        const raw = await deps.kvGet(key);
        const scheduleId = raw ? (JSON.parse(raw) as { scheduleId: string }).scheduleId : null;
        await reportMarker('schedule-registered', {
          duplicateAttempt: true,
          scheduleId,
        });
        return { status: 'unresolved-prior-attempt', scheduleId };
      }

      const schedule = await deps.createSchedule();
      await deps.kvSet(key, JSON.stringify({ scheduleId: schedule.id }));

      await reportMarker('schedule-registered', { scheduleId: schedule.id });

      await deps.toolResultCache.completeStarted(
        cacheKey,
        attemptId,
        {
          status: 'completed',
          result: { scheduleId: schedule.id },
          toolName: 'register-schedule',
          executedAt: Date.now(),
          ttl: 0,
        },
        0,
      );
      return { status: 'completed', scheduleId: schedule.id };
    },
  });

  // AB-336: `signal-parked` is now the REAL `requestHumanInput` durable
  // park (`BureauOptions.humanInput: true` wires that tool in
  // automatically) — no bespoke blocking tool needed here. See this file's
  // top comment and the park-wait block in `main()` below.
  return createToolbox([registerChild, performEffect, registerChildren, registerSchedule]);
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
const FIXTURE_KINDS = ['linear', 'nested-children', 'schedule-fire', 'recovery-failure'] as const;

const USAGE =
  'crash fixture: usage: fixture.ts <storage-path> <sqlite|lmdb> <primary|recovery> ' +
  '<linear|nested-children|schedule-fire|recovery-failure> [rootRunId] [--gateway]';

function parseMode(value: string | undefined): FixtureMode {
  if (value === 'primary' || value === 'recovery') return value;
  throw new Error(USAGE);
}

function parseBackend(value: string | undefined): FixtureBackend {
  if (value === 'sqlite' || value === 'lmdb') return value;
  throw new Error(USAGE);
}

function parseKind(value: string | undefined): CrashScenarioKind {
  if ((FIXTURE_KINDS as readonly string[]).includes(value ?? '')) return value as CrashScenarioKind;
  throw new Error(USAGE);
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  // `--gateway` (AB-275) is a trailing flag, not a positional — strip it out
  // first so the existing
  // `<sqlite|lmdb>`/`<primary|recovery>`/`<kind>`/`[rootRunId]` positional
  // parsing below is unaffected whether or not it is present.
  const enableGateway = rawArguments.includes('--gateway');
  const [storagePath, backendArgument, modeArgument, kindArgument, existingRootRunId] =
    rawArguments.filter((argument) => argument !== '--gateway');
  if (!storagePath) {
    throw new Error(USAGE);
  }
  const backend = parseBackend(backendArgument);
  const mode = parseMode(modeArgument);
  const kind = parseKind(kindArgument);

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

  const generate = createFixtureGenerate(kind);

  // AB-271 recovery-failure scenario: the catalog agent exists ONLY in
  // primary mode. The second process's `agents` map deliberately omits it —
  // the exact "an agent definition deliberately absent from its catalog"
  // shape the acceptance criteria names. Internally, `resolveRunServices`'s
  // catalog branch (`runtime-composition.ts`'s `resolveCatalogAgentRunServices`)
  // classifies this as `{ status: 'missing-agent' }`, but that classification
  // is never surfaced outward on its own — what's actually observable
  // (through `bureau.getDurableRun`, read in `main()`'s recovery branch
  // below) is the workflow-level failure that classification produces:
  // `{ status: 'unavailable', reason: 'run <id>: catalog agent "..." is no
  // longer in the catalog' }`, which is AB-29's own class of observable
  // recovery failure, never a bare `null`.
  const agents: AgentDefinitions =
    kind === 'recovery-failure' && mode === 'primary'
      ? {
          [GHOST_AGENT_NAME]: createAgent({
            // Step 0 dispatches a trivial tool call so its own step commits
            // durably (Weft's per-step memo only resolves once the tool
            // itself has settled); step 1's `generate` call then NEVER
            // resolves — mirroring `create-bureau.test.ts`'s own
            // `bureauA`/`bureauB` catalog-recovery test ("the 'process'
            // dies here") — so this run is GENUINELY non-terminal
            // (`status: 'running'`) at the instant the harness kills the
            // process, never a race against a single-step run that could
            // complete before the kill lands.
            generate: async ({ step }) => {
              if (step === 0) {
                return {
                  content: '',
                  toolCalls: [{ id: 'crash-fixture-ghost-noop', name: 'noop', arguments: {} }],
                };
              }
              return new Promise<never>(() => {});
            },
            toolbox: createToolbox([
              createTool({
                name: 'noop',
                version: '1.0.0',
                description:
                  'Does nothing; exists only to give the ghost agent a real, committed step 0.',
                input: z.object({}),
                async execute() {
                  return { ok: true };
                },
              }),
            ]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        }
      : {};

  const harness = await createBureauTestHarness({
    agents,
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
    async createSchedule() {
      const summary = await bureau.createSchedule({
        agentName: 'crash-fixture-schedule-agent',
        input: 'crash-fixture scheduled tick',
        spec: '1h',
      });
      if (!summary) {
        throw new Error(
          'crash fixture: bureau.createSchedule returned undefined — no durable engine composed',
        );
      }
      return { id: summary.id };
    },
  });

  // AB-275: started BEFORE the 'ready' marker fires, over the SAME
  // `ManualRuntimeServices` (`runtime`, already shared with the storage
  // fixture above) `startLoopbackGateway` shares between bureau and
  // gateway — so the bound port is available to report in 'ready's own
  // `detail`, matching `startLoopbackGateway`'s own composition.
  let runningGateway: Awaited<ReturnType<Gateway['start']>> | undefined;
  let gatewayPort: number | undefined;
  if (enableGateway) {
    const gateway = await createGateway(bureau, {
      port: 0,
      hostname: '127.0.0.1',
      authToken: CRASH_FIXTURE_GATEWAY_AUTH_TOKEN,
      runtime,
    });
    runningGateway = await gateway.start();
    gatewayPort = runningGateway.port;
  }

  await reportMarker('ready', gatewayPort !== undefined ? { gatewayPort } : undefined);

  // AB-271 recovery-failure scenario: an entirely separate driver path —
  // catalog dispatch (`bureau.run`/`harness.startRun`) rather than the
  // session/durable-execution root every other kind uses, and no
  // signal-park/cancel life cycle at all. Falls through to the shared
  // close/cleanup tail below like every other kind.
  if (kind === 'recovery-failure') {
    if (mode === 'primary') {
      harness.startRun(GHOST_AGENT_NAME, 'go');
      // `AgentRun.snapshot().id` on a catalog dispatch is the CATALOG NAME,
      // not the minted durable workflow id — read the real id back off the
      // engine's own listing (AB-240's own test does the same). This kind
      // never dispatches a `bureau.createRun` root, so the catalog run is
      // the only entry `listDurableRuns()` ever returns for this process.
      let catalogRunId: string | undefined;
      await waitForCondition(
        async () => {
          const listed = await bureau.listDurableRuns();
          catalogRunId = listed?.items[0]?.id;
          return !!catalogRunId;
        },
        'crash fixture: catalog run never became discoverable via listDurableRuns',
        backend === 'lmdb' ? 400 : 5000,
        backend === 'lmdb' ? realDelayYield : undefined,
      );
      currentRootRunId = catalogRunId ?? '';
      harness.registerDurableRun(currentRootRunId);
      await reportMarker('catalog-run-started', {
        runId: currentRootRunId,
        agentName: GHOST_AGENT_NAME,
      });
    } else {
      // Recovery: `GHOST_AGENT_NAME` is absent from THIS process's `agents`
      // map (see its construction above) — `resolveRunServices`'s catalog
      // branch (`runtime-composition.ts`'s `resolveCatalogAgentRunServices`)
      // returns `{ status: 'unavailable', reason: '... is no longer in the
      // catalog' }`, and Weft fails the workflow with that reason as its
      // `error`/`errorStack` and a `failureCategory` — never leaving it
      // `null` or silently non-terminal. `bureau.getDurableRun` is the SAME
      // public surface every other scenario in this matrix already reads
      // `final-root-workflow-state` through (never a durable-store read),
      // so this scenario proves the AB-29-class failure detail is
      // observable there too, not only via `SessionHandle.recover()`.
      harness.registerDurableRun(currentRootRunId);
      await waitForCondition(
        async () => {
          const state = await bureau.getDurableRun(currentRootRunId);
          return !!state && state.status === 'failed';
        },
        `crash fixture: catalog run "${currentRootRunId}" never reached a failed status on recovery`,
        backend === 'lmdb' ? 400 : 5000,
        backend === 'lmdb' ? realDelayYield : undefined,
      );
      const failedState = await bureau.getDurableRun(currentRootRunId);
      reportObservation(
        'recovery-failure-detail',
        toJson({
          status: failedState?.status ?? null,
          error: failedState?.error ?? null,
          failureCategory: failedState?.failureCategory ?? null,
        }),
      );
    }
  } else if (mode === 'primary') {
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

  // AB-271: the recovery-failure scenario's catalog run never goes through
  // this fixture's own park/cancel life cycle at all — it settles (or, on
  // recovery, fails) entirely on its own, observed above instead. Every
  // other kind drives the shared signal-parked/cancellation-recorded flow
  // below unchanged.
  if (kind !== 'recovery-failure') {
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
          if (kind === 'nested-children') {
            // AB-271: Bureau exposes no native parent→child cancellation
            // cascade for a durable run (AB-92's decision record: "child
            // runs — no standalone locator by design") — this fixture's own
            // driver performs the cascade explicitly, through the SAME
            // public `abortRun` every other cancellation in this file uses,
            // reading each child's identity back from the durable KV record
            // `register-children` wrote before the kill.
            for (let index = 0; index < 2; index += 1) {
              const raw = await kv.get(nestedChildKvKey(currentRootRunId, index));
              const childRunId = raw
                ? (JSON.parse(raw) as { childRunId: string }).childRunId
                : undefined;
              if (childRunId) bureau.abortRun(childRunId);
            }
          }
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
  } // kind !== 'recovery-failure'

  const finalRootState = currentRootRunId ? await bureau.getDurableRun(currentRootRunId) : null;
  reportObservation('final-root-workflow-state', toJson(finalRootState));

  const childRaw = currentRootRunId ? await kv.get(childKvKey(currentRootRunId)) : null;
  reportObservation('child-record', childRaw ? toJson(JSON.parse(childRaw)) : null);

  if (kind === 'nested-children' && currentRootRunId) {
    // Both children's identity records (durable KV, written before any
    // kill point in this scenario) plus their post-cascade-abort terminal
    // states — the two positive assertions the AC names: identity survives
    // recovery, and aborting the recovered root aborted both children.
    const nestedChildren: JsonValue[] = [];
    for (let index = 0; index < 2; index += 1) {
      const raw = await kv.get(nestedChildKvKey(currentRootRunId, index));
      const record = raw ? (JSON.parse(raw) as { childRunId: string; parentRunId: string }) : null;
      const childState = record ? await bureau.getDurableRun(record.childRunId) : null;
      nestedChildren.push(
        toJson({
          index,
          record,
          status: childState && typeof childState === 'object' ? (childState.status ?? null) : null,
        }),
      );
    }
    reportObservation('nested-children', nestedChildren);
  }

  if (kind === 'schedule-fire' && currentRootRunId) {
    const scheduleRaw = await kv.get(scheduleKvKey(currentRootRunId));
    const scheduleId = scheduleRaw
      ? (JSON.parse(scheduleRaw) as { scheduleId: string }).scheduleId
      : null;
    const scheduleSummary = scheduleId ? await bureau.getSchedule(scheduleId) : null;
    reportObservation('schedule-summary', toJson(scheduleSummary ?? null));
  }

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

  // AB-275: the gateway's own listener is stopped BEFORE the bureau shuts
  // down — `startLoopbackGateway.stop()`'s own ordering (`running.stop()`
  // then `bureau.shutdown()`) — so no in-flight gateway request or stream
  // is still touching the bureau while it tears down.
  if (runningGateway) {
    const gatewayShutdownReport = await runningGateway.stop();
    reportObservation('gateway-shutdown-report', toJson(gatewayShutdownReport));
  }

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
