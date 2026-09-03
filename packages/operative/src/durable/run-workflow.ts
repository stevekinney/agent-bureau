import { workflow } from '@lostgradient/weft';
import { Conversation, isConversation } from 'conversationalist';

import { BudgetExceededError, ElicitationDeniedError, GuardrailTripwireError } from '../errors';
import { RunErrorEvent } from '../events';
import { buildStepDeps, createRunState } from '../loop';
import {
  UnsupportedRunResultLegacyFieldError,
  UnsupportedRunResultVersionError,
} from '../run-envelope';
import { DEFAULT_MAXIMUM_STEPS, runStep } from '../run-step';
import type { FinishReason } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import {
  buildSignalContinuationInput,
  buildWakeupContinuationInput,
  renderSignalContinuation,
  renderWakeupContinuation,
} from './continuation-input';
import { isScheduledAgentRunInput, type ScheduledAgentRunInput } from './schedule-agent';
import { createStorageActivities } from './storage-activities';
import type {
  DurableRunDeps,
  PendingHumanWait,
  PendingWakeup,
  RunCursor,
  StepRecord,
} from './types';

/**
 * The durable agent-run workflow.
 *
 * This is the **single-code-path durable driver**. It does NOT reimplement the
 * step body: it calls the exact same {@link runStep} the in-memory `executeLoop`
 * calls, once per checkpointed step. Under inline mode the generator runs
 * in-process, so `runStep` emits to the same event emitter, runs the same hooks,
 * applies the same retry/schema/compaction/guardrail logic, and executes tools
 * the same way — happy-path behavior is byte-identical to a non-durable run,
 * because it is the same code. What the durable path adds is a checkpoint at
 * each step boundary, so a crash resumes from the last completed step.
 *
 * @remarks
 * The load-bearing invariant: **no `Conversation` instance and no contaminated
 * `RunState` is ever a live workflow local across a `yield*`.** `runStep` runs
 * entirely inside a no-`yield*` region (a plain `await`): it rehydrates a fresh
 * `Conversation.from(snapshot)`, mutates it, and pushes a `StepResult` (which
 * embeds that live `Conversation`) into a freshly-built `RunState.steps`. Before
 * the next `yield*`, that step is projected to a plain {@link StepRecord} (no
 * `Conversation`), the transcript is re-snapshotted, and the contaminated
 * instances go out of scope. Only plain, cloneable data — the {@link RunCursor}
 * (step index + accumulators) and the conversation snapshot — crosses a
 * checkpoint boundary.
 *
 * **Durability granularity is one whole step** (generate + tools together). This
 * is a forced consequence of the one-code-path design: `yield*` cannot cross
 * into the plain-`async` `runStep`, so tool execution cannot be a finer-grained
 * activity without splitting the step body (which would fork the loop). The cost
 * is exactly what the design doc §4 documents and accepts: a crash mid-step
 * re-runs that step, i.e. at most one re-charged LLM call per crash.
 *
 * Deferred seams (these only degrade the resume window, never the happy path):
 *
 * TODO(weft-integration): #1 durable in-step retry counters — `runStep`'s
 *   internal `onError` do/while and schema-retry decisions are not individually
 *   checkpointed, so a mid-step crash re-runs the whole step's retries from the
 *   step boundary rather than the exact retry attempt.
 * #11 hook side-effect-ness on resume — RESOLVED via idempotency, not gating.
 *   On resume the crashed in-flight step re-runs from its boundary, so a
 *   side-effecting hook inside it fires again (at-least-once) — the SAME contract
 *   as side-effecting tools (#4 ADR below). The fix is to make effectful hooks
 *   idempotent, NOT to skip them on replay: skipping would drop the side effect
 *   for a step whose work (generate + tools) DID re-execute, leaving external
 *   state out of sync with a step that ran. Read-only hooks are harmless and need
 *   nothing. The gateway's only effectful run hook, `createMemoryPersistHook`, is
 *   idempotent via a DETERMINISTIC `${runId}:${step}` dedupe key (NOT content —
 *   a replayed step can regenerate different content): it skips the write when a
 *   memory already carries that key, so a re-fire is a guaranteed no-op. Hooks
 *   carry a `replay: 'safe' | 'effectful'` classification (lifecycle
 *   `HookRegistrationOptions`) for documentation/diagnostics; it does NOT gate
 *   execution. Earlier plan to filter effectful hooks on replay was rejected as
 *   unsound (skipped-side-effect semantics + fragile function-identity tracking).
 *
 * #4 sub-step tool durability — the `runStep` split is REJECTED (do not
 *   re-attempt): durability granularity is one whole step (generate + all its
 *   tools), so a crash after generate but before the step memo commits re-runs the
 *   step and re-executes its tools (at-least-once). Splitting `runStep` to
 *   checkpoint tool execution independently is unsound (a live `Conversation`
 *   cannot cross a `yield*`; `response` carries non-cloneable SDK objects;
 *   `stepToolbox` is hook-mutated) and the payoff is marginal (`ctx.memo` already
 *   frees completed steps). Side-effecting tools use armorer's existing
 *   content-keyed `withIdempotency` instead. Full ADR + the upstream primitive
 *   (weft#444): documentation/weft-030-recovery-rewrite-design.md.
 * #6 structured-error fidelity — `registerSerializer(ZodError)` is NOT wired
 *   (no consumer reads the structured error off the terminal durable result, and
 *   it would make the schema-validation path depend on a global one-shot
 *   registration to not throw). Rationale + one-liner to enable: same design doc.
 */

/** Input to the durable agent-run workflow. */
export interface AgentRunWorkflowInput {
  runId: string;
  /**
   * The bureau session that owns this run. Carried in the durable input (not a
   * side table) so boot recovery can correlate a recovered `WorkflowHandle` back
   * to its session — the resolver reads it as `info.input.sessionId` and
   * `recoverDurableRuns` reads it via `handle.getLaunchMetadata()` — without
   * scanning the session store by `lastRunId`. A plain cloneable string, safe to
   * checkpoint.
   */
  sessionId: string;
  /**
   * The name of the agent that owns this run (F2 — RunRef.agentName).
   *
   * Carried in the durable input (not a side table) so a recovered workflow can
   * be correlated to its owning agent without reading the session store. A session
   * may be worked by a SEQUENCE of different agents over time (via handoff);
   * agentName on each workflow uniquely identifies which agent ran each run.
   */
  agentName: string;
  /** The first user message to seed a brand-new run (ignored on resume). */
  prompt?: string;
  /** Safety bound on step count, mirroring `RunOptions.maximumSteps`. */
  maximumSteps?: number;
}

/**
 * Narrow an `unknown` durable input (as Weft surfaces it via
 * `resolveWorkflowServices`'s `info.input` and `WorkflowHandle.getLaunchMetadata`)
 * to an {@link AgentRunWorkflowInput}. A type guard, not an `as` cast: the input
 * crosses the checkpoint as plain JSON, so its shape must be validated at the
 * trust boundary. Requires the three correlation fields recovery depends on
 * (`runId`, `sessionId`, `agentName`); a run checkpointed before `agentName` was
 * added to the input fails this guard and is treated as not-reconstructable (no
 * compatibility-bridge fallback — cross-upgrade in-flight runs are out of scope).
 */
export function isAgentRunWorkflowInput(value: unknown): value is AgentRunWorkflowInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['runId'] !== 'string' ||
    typeof candidate['sessionId'] !== 'string' ||
    typeof candidate['agentName'] !== 'string'
  ) {
    return false;
  }
  // Validate the optional fields too, so a narrowed value is sound end-to-end
  // (not just for the three correlation fields recovery keys on).
  const prompt = candidate['prompt'];
  if (prompt !== undefined && typeof prompt !== 'string') return false;
  const maximumSteps = candidate['maximumSteps'];
  if (maximumSteps !== undefined && typeof maximumSteps !== 'number') return false;
  return true;
}

/** Plain, cloneable summary returned when the durable run completes. */
export const AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION = 2 as const;

export interface AgentRunWorkflowResult {
  schemaVersion: typeof AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION;
  runId: string;
  steps: number;
  content: string;
  finishReason: FinishReason;
  /**
   * Serialized message of the error that ended the run, when `finishReason` is
   * `error` / `elicitation-denied` / `budget-exceeded`. The live error object is
   * not cloneable across a checkpoint, so only its message survives; the adapter
   * rebuilds an `Error` from it so consumers (e.g. gateway's `lastError`) see the
   * real cause rather than a synthetic placeholder.
   */
  errorMessage?: string;
  /** The abort reason, when `finishReason` is `aborted`. */
  abortReason?: string;
  /**
   * The structured-output validation outcome, when the run stopped after a
   * `output` was applied. Mirrors `RunResult.schemaValidation` on the
   * in-memory path; `success` — the load-bearing bit — is preserved exactly.
   *
   * KNOWN SEAM (structural fidelity of `error`): the in-memory path puts the
   * LIVE validation error in `schemaValidation.error` (typically a `ZodError`
   * with structured `.issues`); a live error is not cloneable across a
   * checkpoint, so the durable path serializes it to its message and the adapter
   * rebuilds a plain `Error(message)`. A consumer reading `error.issues` /
   * `error.name` therefore sees the structured error in-memory but a plain
   * `Error` on the durable path. This matches the same structural-vs-identity
   * boundary already accepted for terminal `RunResult.error` (stack/cause are
   * likewise reduced to a message) and for conversations (snapshots, not
   * instances). operative cannot faithfully reconstruct an arbitrary user
   * schema library's error type; `success` is the contract, the error shape is
   * best-effort.
   */
  schemaValidation?: { success: boolean; error?: string };
  /**
   * The `output`-validated structured output, when the run stopped
   * after a `output` was applied AND validation succeeded. Mirrors
   * `RunResult.output` on the in-memory path. Unlike
   * `schemaValidation.error`, this is already plain (JSON-parsed and
   * validated) data, so it crosses the checkpoint boundary unchanged — no
   * serialize/reconstruct step is needed the way `schemaValidation.error`
   * needs one. (A Standard Schema validator whose `transform` produces a
   * non-JSON value, e.g. a `Date`, would NOT survive the checkpoint
   * faithfully — this is a durable-path constraint on schema authors, not a
   * bug: only JSON-serializable structured output round-trips.)
   */
  output?: unknown;
  /**
   * D6/AB-45 — The note from the LAST `scheduleWakeup` call the run genuinely
   * parked on and woke from (`yield* ctx.sleep(duration)` completed). Mirrors
   * `humanWaitSignal`'s contract exactly: a historical fact ("this run did
   * sleep on this wakeup"), not a live-park indicator — it remains set on the
   * FINAL result even after the fired wakeup continued the run with one more
   * generation step (or several, if the continuation itself re-parked), and
   * regardless of how the run eventually terminates. Absent when no wakeup
   * was ever genuinely parked on (including when a `scheduleWakeup` call was
   * pending at the moment of a terminal failure — that wakeup never fires,
   * see `isFailureOutcome`'s gate on the park block below) or when the fired
   * wakeup carried no note.
   */
  wakeupNote?: string;
  /**
   * F3 — The LAST signal name the run genuinely parked on via
   * `requestHumanInput` and was released for. Present once the workflow has
   * completed a `yield* ctx.waitForSignal(signalName)` (AB-44 — resume agent
   * reasoning with a delivered signal payload). This is a historical fact
   * ("this run did park on this signal"), not a live-park indicator — it
   * remains set on the FINAL result even after the delivered payload
   * continued the run with one more generation step (or several, if the
   * continuation itself re-parked), and regardless of how the run eventually
   * terminates. Callers can surface this so a later inspection knows which
   * signal most recently drove the run's resume.
   */
  humanWaitSignal?: string;
  /**
   * The tripped guardrail's identity, when `finishReason` is `'tripwire'`. The
   * live `GuardrailTripwireError` is not cloneable across a checkpoint, so its
   * identifying fields are carried here (plain, cloneable) and the adapter
   * rebuilds the error from them — mirroring `errorMessage`'s
   * serialize/rebuild contract for `elicitation-denied` / `budget-exceeded`.
   */
  tripwire?: {
    guardrailName: string;
    category: string;
    phase: 'input' | 'output';
    confidence: number;
    detail?: string;
  };
}

/**
 * Normalize a workflow summary at the durable trust boundary.
 */
export function normalizeAgentRunWorkflowResult(value: unknown): AgentRunWorkflowResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid durable agent run workflow result');
  }

  const summary = value as Record<string, unknown>;
  if (summary['schemaVersion'] !== AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION) {
    throw new UnsupportedRunResultVersionError(summary['schemaVersion']);
  }
  if ('structuredOutput' in summary) {
    throw new UnsupportedRunResultLegacyFieldError('structuredOutput', summary['schemaVersion']);
  }

  return value as AgentRunWorkflowResult;
}

/** Serialize an unknown error to a stable message string for the checkpoint. */
function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Classify a terminal error into a {@link FinishReason}, identically to
 * `makeErrorResult` in run-lifecycle.ts. Called INSIDE the memo where the live
 * error object still exists (its class identity is lost once serialized across
 * the checkpoint), so the durable path distinguishes `elicitation-denied` and
 * `budget-exceeded` from a plain `error` exactly as the in-memory loop does.
 */
function classifyErrorFinishReason(error: unknown): FinishReason {
  if (error instanceof ElicitationDeniedError) return 'elicitation-denied';
  if (error instanceof BudgetExceededError) return 'budget-exceeded';
  if (error instanceof GuardrailTripwireError) return 'tripwire';
  return 'error';
}

/**
 * Plain, cloneable projection of a {@link GuardrailTripwireError}'s identifying
 * fields, captured INSIDE the memo where the live error still exists (its
 * guardrail identity does not survive serialization across the checkpoint).
 * Carried on {@link AgentRunWorkflowResult} so the adapter can reconstruct the
 * error and fire `RunTripwireEvent` on the durable path exactly as the
 * in-memory loop does.
 */
function tripwireDetailFrom(error: unknown): AgentRunWorkflowResult['tripwire'] {
  if (!(error instanceof GuardrailTripwireError)) return undefined;
  return {
    guardrailName: error.guardrailName,
    category: error.category,
    phase: error.phase,
    confidence: error.confidence,
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
  };
}

/**
 * The fresh cursor for a brand-new run: step 0, zeroed accumulators, stamped
 * with the workflow version this run was created under (AB-10 — workflow
 * versioning). `version` is `undefined` when the engine was built without
 * {@link CreateRunWorkflowOptions.version}.
 */
/**
 * `initialAppliedConfigVersion` seeds `lastAppliedConfigVersion` from the
 * run's `SteeringGate.getAppliedFloor()` (AB-199 cross-run dedupe), mirroring
 * `loop.ts`'s `createRunState()` seed. Defaults to 0 — a run with no
 * steering dependency, or replay reconstructing this same value again, is
 * unaffected.
 */
function initialCursor(version: string | undefined, initialAppliedConfigVersion = 0): RunCursor {
  return {
    step: 0,
    totalUsage: { prompt: 0, completion: 0, total: 0 },
    lastContent: '',
    schemaAttempts: 0,
    lastAppliedConfigVersion: initialAppliedConfigVersion,
    ...(version !== undefined ? { workflowVersion: version } : {}),
  };
}

/**
 * Narrow the engine-provided `ctx.services` to this run's {@link DurableRunDeps}.
 *
 * Weft 0.2.1 types `ctx.services` as `unknown`; the engine guarantees it is the
 * exact value supplied at `engine.start(type, input, { services })` — or the
 * value `resolveWorkflowServices` rebuilt on a cross-process recovery — for this
 * specific run. `DurableRunDeps` holds live, non-serializable closures
 * (`generate`, `toolbox`, hooks, emitter), so it cannot be validated with a
 * runtime schema; this single documented cast at the engine trust boundary is
 * the only `as` in this module. Call it ONLY inside no-`yield*` regions: the deps
 * must never be held as a live workflow local across a checkpoint.
 */
function runDepsFrom(services: unknown): DurableRunDeps {
  return services as DurableRunDeps;
}

/** Options for {@link createRunWorkflow}. */
export interface CreateRunWorkflowOptions {
  /**
   * The workflow version identifier stamped into every new run's cursor at
   * creation (AB-10 — workflow versioning for in-flight durable runs). Pass
   * the same value to {@link import('./create-run-engine').CreateRunEngineOptions.runWorkflowVersion}
   * so recovery can compare a resumed run's stamped version against the
   * currently-registered one and surface a mismatch via
   * `onWorkflowVersionMismatch` — see that option's JSDoc for why this is a
   * SEPARATE, softer mechanism from Weft's own `workflow({ version })`
   * recovery check (which throws and aborts the WHOLE fleet's `recoverAll()`
   * on a single mismatched run; not used here). Omit to disable stamping —
   * every run's `workflowVersion` is then `undefined` and no mismatch is ever
   * reported.
   */
  version?: string;
}

/**
 * Builds the durable `agentRun` workflow over the given {@link CheckpointStore}.
 * The storage activities are created from the same store the engine persists to,
 * so the workflow's reads and writes share one backend.
 */
export function createRunWorkflow(
  checkpointStore: CheckpointStore,
  options: CreateRunWorkflowOptions = {},
) {
  const storage = createStorageActivities(checkpointStore);
  const workflowVersion = options.version;

  return (
    workflow({ name: 'agentRun' })
      .activities({
        saveCursor: storage.saveCursor,
        saveConversation: storage.saveConversation,
        recordStep: storage.recordStep,
      })
      // A Weft workflow body MUST be an `async function*`: every durable operation
      // goes through `yield*` (ctx.run / ctx.memo), never a bare top-level `await`
      // — a bare await would not be checkpointed. So the generator correctly has no
      // own-level `await`; require-await is a false positive for this pattern.
      // eslint-disable-next-line @typescript-eslint/require-await -- Weft durable generator: async work flows through yield*, not a top-level await.
      .execute(async function* (ctx, input: AgentRunWorkflowInput | ScheduledAgentRunInput) {
        // The per-fire/per-run id is ALWAYS `ctx.workflowId`. For a normal run
        // `input.runId === ctx.workflowId` (engine.start pins `{ id: runId }`, and
        // the resolver's mismatch guard enforces it), so this is behavior-
        // preserving. For a NATIVE SCHEDULED FIRE the input is a
        // ScheduledAgentRunInput with NO `runId`: weft mints a fresh `workflowId`
        // per fire and passes the registered input through unchanged, so the only
        // per-fire identity the body can read is `ctx.workflowId` (#109). A baked
        // runId in the input would collide every fire's storage keys.
        const runId = ctx.workflowId;
        // A scheduled fire carries no `maximumSteps`/`prompt` on its input — those
        // come from the resolver-built deps (the conversation is pre-seeded with
        // the prompt, and the step cap rides on `options.maximumSteps`). Gate the
        // input-shape-specific reads behind the type guard so a ScheduledAgentRunInput
        // is never read as if it were an AgentRunWorkflowInput.
        const scheduled = isScheduledAgentRunInput(input);
        const maximumSteps =
          (scheduled ? undefined : input.maximumSteps) ??
          runDepsFrom(ctx.services).options.maximumSteps ??
          DEFAULT_MAXIMUM_STEPS;

        // CRITICAL: `ctx.services` (via `runDepsFrom`) is read ONLY inside
        // no-`yield*` regions, never held as a local across a yield. The deps hold
        // non-serializable closures (generate, toolbox, hooks, emitter); keeping
        // them live across a checkpoint would fail validateCloneable or be lost on
        // resume. Same rule as the Conversation instance and the contaminated
        // RunState.
        //
        // RECOVERY (seam #5): on a fresh-process resume the engine re-provides this
        // run's deps through `resolveWorkflowServices` BEFORE the generator advances
        // (see create-run-engine.ts), so `ctx.services` is populated here without
        // any in-workflow reconstruction step. A run whose deps cannot be rebuilt is
        // failed terminally by the engine before replay — the body never sees it —
        // so there is no "could not reconstruct" branch to own here anymore.

        // DURABLE WORKFLOW LOCALS. These are the resume position — Weft snapshots
        // live locals at every `yield*` and restores them on resume, so the cursor
        // and transcript survive a crash WITHOUT being re-read through an activity.
        // (Re-reading via a load activity is wrong: Weft caches the activity's first
        // result and replays that stale value on resume, defeating the reload.) Both
        // are plain/cloneable: `cursor` is `{ step, accumulators }`, `snapshot` is a
        // structuredClone-safe `ConversationSnapshot` tree — never a `Conversation`
        // instance. The checkpoint-store writes below exist only so the ActiveRun
        // adapter can reconstruct the RunResult post-completion; they are not the
        // workflow's own resume mechanism.
        let cursor: RunCursor = initialCursor(
          workflowVersion,
          runDepsFrom(ctx.services).options.steering?.getAppliedFloor?.() ?? 0,
        );

        // Seed the conversation on the first run from the run's options + prompt,
        // then persist it so the adapter and any external reader see the transcript.
        const seededConversation = (() => {
          const options = runDepsFrom(ctx.services).options;
          const seeded = isConversation(options.conversation)
            ? options.conversation
            : new Conversation(options.conversation);
          // Only a normal run appends `input.prompt` here; a scheduled fire's
          // prompt is already seeded into `options.conversation` by the resolver
          // (and ScheduledAgentRunInput has no `prompt` field), so appending again
          // would duplicate the user turn.
          if (!scheduled && input.prompt !== undefined) {
            seeded.appendUserMessage(input.prompt);
          }
          return seeded.snapshot();
        })();
        let snapshot = seededConversation;
        yield* ctx.run('saveConversation', { runId, snapshot });

        let finishReason: FinishReason = 'maximum-steps';
        let errorMessage: string | undefined;
        let abortReason: string | undefined;
        let schemaValidation: { success: boolean; error?: string } | undefined;
        let output: unknown;
        let tripwire: AgentRunWorkflowResult['tripwire'];
        // True when a terminal outcome (stop/abort/error) broke the loop early.
        // False means the loop exhausted `maximumSteps` naturally — the only case
        // where `onMaximumSteps` should run, mirroring `executeLoop` exactly.
        let stoppedEarly = false;

        // === Durable park-request locals (D6 + F3 recovery fix) ===
        // These accumulate the LAST pending park request (wakeup or human-wait)
        // from step results. The tool mutations happen inside `ctx.memo` (where
        // `deps` is live), so the values are captured in the memo return value and
        // survive a crash+recovery: on replay each memo short-circuits to its
        // checkpointed result, which carries the park request the tool set. This
        // is the ONLY source of park state used post-loop — we no longer read
        // `ctx.services` for this purpose, because services are rebuilt fresh on
        // recovery (with `pendingWakeup`/`pendingHumanWait` unset). Last-write-wins
        // matches the in-process tool semantics (multiple wakeup calls overwrite).
        let pendingWakeup: PendingWakeup | undefined;
        let pendingHumanWait: PendingHumanWait | undefined;

        // AB-44 — F3 signal-payload resume. The signal name a `requestHumanInput`
        // park most recently, successfully waited on and was released for, kept
        // for the FINAL result's `humanWaitSignal` field even after the run
        // continues past that park (`pendingHumanWait` itself is cleared the
        // moment its signal is consumed — see the park block below — so the
        // result can't just read it). This is a historical fact ("this run did
        // park on this signal"), not a live-park indicator, so it is reported
        // regardless of how the run eventually terminates.
        let lastHumanWaitSignal: string | undefined;

        // AB-45 — the note from a `scheduleWakeup` park this run genuinely
        // slept on and woke from, kept for the FINAL result's `wakeupNote`
        // field even after the run continues past that park (`pendingWakeup`
        // itself is cleared the moment the sleep resolves — see the park
        // block below — so the result can't just read it). Mirrors
        // `lastHumanWaitSignal`'s contract exactly.
        let lastWakeupNote: string | undefined;

        // AB-44/AB-45 — outer resume loop. AB-41's decision record: a delivered
        // signal (this issue) or a fired wakeup (AB-45) CONTINUES the same run
        // with one more agent generation step, never merely delaying terminal
        // completion. The inner step loop below runs until a genuine terminal
        // outcome or `maximumSteps`; the durable-park block after it either ends
        // the workflow (no pending park, or `AB-45`'s still-terminal
        // `ctx.sleep`) or — for a delivered signal — appends the continuation
        // message and `continue`s this outer loop to run more steps. Re-parking
        // from within a continuation step is therefore just the outer loop
        // running again; no separate code path.
        while (true) {
          while (cursor.step < maximumSteps) {
            // === The whole step runs inside `ctx.memo`, keyed by step index. This is
            // what makes the in-process step durable across RECOVERY (not just the
            // happy path): on a crash + recoverAll, Weft restarts the generator from
            // the top and short-circuits each `ctx.memo` to its checkpointed result
            // WITHOUT re-running the function — so every COMPLETED step's generate +
            // tool execution is skipped, and only the in-flight (un-memoized) step
            // re-runs. Without memo, the in-process generate would re-execute from
            // step 0 on recovery (re-charging the LLM), because plain in-process code
            // is re-run during replay. The memo's return value is the plain, cloneable
            // step projection — no `Conversation` instance, no live error. ===
            const stepIndex = cursor.step;
            const carriedAccumulators = {
              totalUsage: cursor.totalUsage,
              lastContent: cursor.lastContent,
              schemaAttempts: cursor.schemaAttempts,
              lastAppliedConfigVersion: cursor.lastAppliedConfigVersion,
            };
            const stepResult = yield* ctx.memo(`step-${stepIndex}`, async () => {
              const deps = runDepsFrom(ctx.services);
              // AB-44 — clear the run-scoped `pendingHumanWait`/`pendingWakeup`
              // slots BEFORE this step runs, in this no-`yield*` region where
              // `deps` is live. Both slots are sticky (`requestHumanInput`/
              // `scheduleWakeup` only ever SET them; nothing clears either once
              // its park is consumed), so without this reset a step that does
              // NOT call the corresponding tool would still report a PRIOR
              // step's park request as its own. Before AB-44 this never
              // mattered — nothing ran after a park — but now a delivered
              // signal continues the run with more steps, so a stale slot from
              // an earlier step (e.g. a `scheduleWakeup` call two parks ago)
              // could otherwise resurface as this step's own memoized result
              // and re-trigger a park the current step never requested.
              // Clearing here means this step's memoized `pendingHumanWait`/
              // `pendingWakeup` reflect only what THIS step's own tool call (if
              // any) set; cross-step accumulation still happens via the
              // hoisted locals outside the loop (last-write-wins), which are
              // unaffected by this per-step reset.
              deps.pendingHumanWait = undefined;
              deps.pendingWakeup = undefined;
              const conversation = Conversation.from(snapshot);
              // Build StepDeps from the run's options (one code path with executeLoop),
              // overriding only the toolbox with the per-run (variance-widened) one
              // the engine supplied via `ctx.services`.
              const stepDeps = {
                ...buildStepDeps(deps.options),
                toolbox: deps.toolbox,
                // AB-239: threads the driver's toolbox-event forwarder through so a
                // `selectTools`-swapped step toolbox is forwarded for that step too.
                onStepToolbox: deps.onStepToolbox,
                runId,
                durableOperationKeys: true,
              };
              // Carry the accumulators forward; start `steps` empty so this iteration
              // accumulates exactly the one StepResult it produces (and nothing that
              // would otherwise need to cross a yield).
              const runState = createRunState();
              runState.totalUsage = { ...carriedAccumulators.totalUsage };
              runState.lastContent = carriedAccumulators.lastContent;
              runState.schemaAttempts = carriedAccumulators.schemaAttempts;
              runState.lastAppliedConfigVersion = carriedAccumulators.lastAppliedConfigVersion;

              const outcome = await runStep(
                stepDeps,
                runState,
                conversation,
                stepIndex,
                deps.emitter,
              );
              // AB-239: revert the forwarder to the base toolbox now that the
              // step has ended — still inside this no-`yield*` memo region, so
              // this runs before the workflow can park (`ctx.waitForSignal`,
              // `ctx.sleep`) for a step that requested one. See
              // `ToolboxEventForwarder`'s JSDoc.
              deps.onStepToolbox?.(deps.toolbox);

              // Project the (at most one) pushed StepResult to a plain StepRecord —
              // dropping the live Conversation instance — and re-snapshot the
              // transcript. Everything returned here is plain and cloneable.
              const pushed = runState.steps[runState.steps.length - 1];
              const stepMetadata = pushed
                ? {
                    ...(pushed.metadata ?? {}),
                    ...(deps.getStepMetadata?.() ?? {}),
                  }
                : undefined;
              const record: StepRecord | null = pushed
                ? {
                    step: pushed.step,
                    content: pushed.content,
                    toolCalls: pushed.toolCalls,
                    results: pushed.results,
                    ...(pushed.usage ? { usage: pushed.usage } : {}),
                    ...(stepMetadata && Object.keys(stepMetadata).length > 0
                      ? { metadata: stepMetadata }
                      : {}),
                    final: pushed.final,
                  }
                : null;

              // Serialize terminal metadata here, inside the function, where the live
              // (non-cloneable) error object and validation error still exist. Only
              // plain data is memoized. The error finish reason is CLASSIFIED here
              // (elicitation-denied / budget-exceeded / error) because the error's
              // class identity does not survive serialization — matching the
              // in-memory `makeErrorResult`. The `schemaValidation` is carried so a
              // durable run produces the SAME `RunResult.schemaValidation` shape as
              // the in-memory loop (its live error is reduced to a message).
              //
              // pendingWakeup and pendingHumanWait are read from `deps` HERE (where
              // the tool's live mutation already landed) and embedded in the memoized
              // return value. This is critical for recovery correctness: if the process
              // crashes after this memo commits but before the post-loop park executes,
              // Weft re-runs the generator and short-circuits this memo to its
              // checkpointed result — which includes the park request. The post-loop
              // code reads these from the accumulated step results rather than from the
              // rebuilt `ctx.services`, which would be freshly constructed (unset) on
              // recovery. `PendingWakeup`/`PendingHumanWait` are plain, cloneable
              // objects (duration is number|string, signalName is string), so they
              // cross the checkpoint boundary safely.
              return {
                outcome: { kind: outcome.kind },
                errorMessage: outcome.kind === 'error' ? serializeError(outcome.error) : undefined,
                errorFinishReason:
                  outcome.kind === 'error' ? classifyErrorFinishReason(outcome.error) : undefined,
                tripwire: outcome.kind === 'error' ? tripwireDetailFrom(outcome.error) : undefined,
                abortReason: outcome.kind === 'abort' ? outcome.reason : undefined,
                stopFinishReason: outcome.kind === 'stop' ? outcome.finishReason : undefined,
                schemaValidation:
                  outcome.kind === 'stop' && outcome.schemaValidation
                    ? {
                        success: outcome.schemaValidation.success,
                        ...(outcome.schemaValidation.error !== undefined
                          ? { error: serializeError(outcome.schemaValidation.error) }
                          : {}),
                      }
                    : undefined,
                output: outcome.kind === 'stop' ? outcome.output : undefined,
                record,
                conversationSnapshot: conversation.snapshot(),
                nextAccumulators: {
                  totalUsage: runState.totalUsage,
                  lastContent: runState.lastContent,
                  schemaAttempts: runState.schemaAttempts,
                  lastAppliedConfigVersion: runState.lastAppliedConfigVersion,
                },
                pendingWakeup: deps.pendingWakeup,
                pendingHumanWait: deps.pendingHumanWait,
              };
            });

            snapshot = stepResult.conversationSnapshot;

            // Accumulate park requests from this step's memoized result. Last-write-
            // wins across steps, matching the in-process tool semantics (a later
            // `scheduleWakeup`/`requestHumanInput` call overwrites a prior one).
            //
            // MUTUAL EXCLUSIVITY INVARIANT: `pendingWakeup` and `pendingHumanWait`
            // are mutually exclusive — only one park type governs after the loop
            // (DurableRunDeps contract). Enforced here by clearing the OTHER local
            // whenever one is set, so the last-set value wins even across steps.
            // Within a single step's memo result, both could be present if the agent
            // called both tools (an unusual but valid sequence); the `pendingHumanWait`
            // check runs second, so it clears a same-step `pendingWakeup`, matching
            // the reasonable user expectation that an explicit human-input request
            // supersedes an autonomous wakeup schedule.
            if (stepResult.pendingWakeup !== undefined) {
              pendingWakeup = stepResult.pendingWakeup;
              pendingHumanWait = undefined;
            }
            if (stepResult.pendingHumanWait !== undefined) {
              pendingHumanWait = stepResult.pendingHumanWait;
              pendingWakeup = undefined;
            }

            // === Durable commits — all plain data. Order: transcript, then the
            // step record (if any), then the advanced cursor last, so a crash
            // between commits never advances the cursor past un-persisted state. ===
            yield* ctx.run('saveConversation', { runId, snapshot });
            if (stepResult.record !== null) {
              yield* ctx.run('recordStep', { runId, record: stepResult.record });
            }

            const { outcome } = stepResult;

            // A `stop`, `next`, or `continue` all mean the step at `cursor.step`
            // finished its turn — the cursor advances, matching the in-memory `for`
            // loop where both a fall-through and a `continue` run the increment (a
            // skipped step, per-step abort, or schema-retry consumes a step index).
            // An `abort`/`error` aborts mid-step with no completed record, so the
            // cursor stays put: a resumed run re-attempts this same step. `steps` in
            // the result is therefore the count of completed steps, identical to
            // `RunResult.steps.length` in `executeLoop`.
            const aborted = outcome.kind === 'abort' || outcome.kind === 'error';
            cursor = {
              ...cursor,
              step: aborted ? cursor.step : cursor.step + 1,
              ...stepResult.nextAccumulators,
            };
            yield* ctx.run('saveCursor', { runId, cursor });

            if (outcome.kind === 'stop') {
              finishReason = stepResult.stopFinishReason ?? 'stop-condition';
              schemaValidation = stepResult.schemaValidation;
              output = stepResult.output;
              stoppedEarly = true;
              break;
            }
            if (outcome.kind === 'abort') {
              finishReason = 'aborted';
              abortReason = stepResult.abortReason;
              stoppedEarly = true;
              break;
            }
            if (outcome.kind === 'error') {
              // Use the finish reason CLASSIFIED inside the memo (where the error's
              // class identity was still live) so a durable run distinguishes
              // elicitation-denied / budget-exceeded from a plain error, matching
              // the in-memory loop.
              finishReason = stepResult.errorFinishReason ?? 'error';
              errorMessage = stepResult.errorMessage;
              tripwire = stepResult.tripwire;
              stoppedEarly = true;
              break;
            }
            // AB-44 — a `requestHumanInput` tool call must commit its step and
            // park BEFORE another generation call can run without the requested
            // input. A `next`/`continue` outcome alone (e.g. `stopWhen` doesn't
            // trigger because the step's only content was the tool call) would
            // otherwise keep looping into another step immediately, racing the
            // park. Check the fresh per-step value, not the cross-step
            // accumulator: only THIS step's own tool call should force the park.
            if (stepResult.pendingHumanWait !== undefined) {
              stoppedEarly = true;
              break;
            }
            // AB-45 — same fix, mirrored for `scheduleWakeup`: a `next`/
            // `continue` outcome must not race another generation call past a
            // fresh `pendingWakeup` before the post-loop park block ever runs.
            if (stepResult.pendingWakeup !== undefined) {
              stoppedEarly = true;
              break;
            }
            // `next` / `continue` — loop to the next step.
          }

          // === onMaximumSteps tail — parity with executeLoop ===
          // When the loop exhausted `maximumSteps` without a terminal outcome (stop
          // / abort / error), call `options.onMaximumSteps` exactly once, mirroring
          // executeLoop lines 141-158. Wrapped in `ctx.memo` so a crash-then-
          // recover does NOT re-charge the LLM call: Weft short-circuits the memo
          // to its checkpointed result on replay, just as it does for per-step
          // memos. `finishReason` stays `'maximum-steps'` regardless of the handler
          // return value — matching the in-memory path. On error, dispatch
          // RunErrorEvent (parity with executeLoop) and short-circuit the return.
          if (!stoppedEarly) {
            const finalStep = cursor.step;
            const tail = yield* ctx.memo('on-maximum-steps', async () => {
              const deps = runDepsFrom(ctx.services);
              const handler = deps.options.onMaximumSteps;
              if (!handler) return { kind: 'noop' as const };
              const conversation = Conversation.from(snapshot);
              try {
                const finalContent = await handler({
                  conversation,
                  step: finalStep,
                  signal: deps.options.signal,
                });
                if (typeof finalContent !== 'string') return { kind: 'noop' as const };
                conversation.appendAssistantMessage(finalContent);
                return {
                  kind: 'content' as const,
                  finalContent,
                  conversationSnapshot: conversation.snapshot(),
                };
              } catch (error) {
                deps.emitter?.dispatch(new RunErrorEvent(finalStep, error, 'policy'));
                return {
                  kind: 'error' as const,
                  errorMessage: serializeError(error),
                  errorFinishReason: classifyErrorFinishReason(error),
                };
              }
            });

            if (tail.kind === 'content') {
              snapshot = tail.conversationSnapshot;
              cursor = { ...cursor, lastContent: tail.finalContent };
              yield* ctx.run('saveConversation', { runId, snapshot });
              yield* ctx.run('saveCursor', { runId, cursor });
            } else if (tail.kind === 'error') {
              finishReason = tail.errorFinishReason;
              errorMessage = tail.errorMessage;
            }
          }

          // === Durable park — exactly one of wakeup or human-wait fires (never both). ===
          // `pendingWakeup` / `pendingHumanWait` were accumulated above from step memo
          // results — they are checkpointed values, NOT `ctx.services` fields. This is
          // the fix for the durable-recovery bug: on a crash AFTER the step memo commits
          // but BEFORE this park executes, Weft replays the generator and short-circuits
          // each memo to its checkpointed result. `ctx.services` is rebuilt fresh on
          // recovery (with both fields unset), so reading from services here would
          // silently skip the park. Reading from the hoisted locals (fed from
          // checkpointed step results) survives recovery correctly.
          //
          // The two locals are kept MUTUALLY EXCLUSIVE by the accumulation loop above:
          // setting one clears the other. The `else if` below is defense-in-depth —
          // it guarantees exactly one park primitive fires regardless of accumulation
          // state, so the workflow cannot sleep AND then wait for a signal in sequence.
          //
          // CRITICAL: Only park on non-failed stop-condition / maximum-steps outcomes. A terminal
          // failure (`error`, `aborted`, `elicitation-denied`, `budget-exceeded`,
          // `tripwire`) must return immediately — parking on a failed/aborted run
          // would leave the Weft workflow status as `running` until the sleep/signal
          // fires, hiding the real outcome and blocking the caller from seeing the
          // error result. This covers both a failing step (outcome.kind === 'abort' |
          // 'error') and a failing `onMaximumSteps` handler (tail.kind === 'error'),
          // because both update `finishReason` before we reach this point. A tripped
          // guardrail is a hard halt by definition — it must never park. Also gates a
          // signal racing a terminal failure (AC): if THIS cycle's step failed, the
          // workflow returns immediately even though a signal may already be sitting
          // in Weft's buffer for `pendingHumanWait.signalName` — it is never consumed.
          const isFailureOutcome =
            finishReason === 'error' ||
            finishReason === 'aborted' ||
            finishReason === 'elicitation-denied' ||
            finishReason === 'budget-exceeded' ||
            finishReason === 'tripwire';
          if (!isFailureOutcome && pendingWakeup !== undefined) {
            // === D6/AB-45 — self-scheduled wakeup (scheduleWakeup tool) ===
            // AB-45 — resume agent reasoning after a durable wakeup, per AB-41's
            // decision record: a fired wakeup CONTINUES the same run with one
            // more generation step; it never merely delays terminal completion.
            // `ctx.sleep` is itself the checkpointed durable operation — a crash
            // either side of this `yield*` is safe: before it, recovery re-issues
            // the same sleep (Weft re-arms the same timer, per AB-41's "Recovery:
            // `ctx.sleep` is checkpointed; recovery re-arms it"); after it (but
            // before the commits below land), recovery re-issues the memoized
            // work below from its checkpoint, never registering a second timer or
            // duplicating the resumed step.
            const requestedDuration = pendingWakeup.duration;
            const note = pendingWakeup.note;
            yield* ctx.sleep(requestedDuration);

            // Consumed: clear the hoisted local so a cycle that ends WITHOUT the
            // continuation step re-scheduling a wakeup does not re-enter this
            // branch and sleep again on the same already-fired request. Record
            // the note separately for the final result — see `lastWakeupNote`'s
            // declaration above.
            pendingWakeup = undefined;
            lastWakeupNote = note;

            // `firedAt` must be a plain, checkpointed value — reading
            // `Date.now()`/`new Date().toISOString()` directly in workflow-body
            // code would be non-deterministic across replay. `ctx.memo` here
            // commits it once and short-circuits to the same value on replay.
            // Keyed by `cursor.step`, matching `signal-delivered-at-${step}`: a
            // re-park needs at least one more committed step first, so each park
            // cycle gets its own key — distinct from the signal branch's key
            // prefix so a step that re-parks on the OTHER primitive next cannot
            // collide with this step's own memo.
            const firedAt = yield* ctx.memo(
              `wakeup-fired-at-${cursor.step}`,
              // eslint-disable-next-line @typescript-eslint/require-await -- ctx.memo requires an async callback; this one has no await of its own.
              async () => new Date().toISOString(),
            );

            const continuationInput = buildWakeupContinuationInput(
              requestedDuration,
              note,
              firedAt,
            );
            const renderedMessage = renderWakeupContinuation(continuationInput);

            const resumedConversation = Conversation.from(snapshot);
            resumedConversation.appendUserMessage(renderedMessage);
            snapshot = resumedConversation.snapshot();
            yield* ctx.run('saveConversation', { runId, snapshot });

            // AC — "the final run result is produced only after the resumed
            // agent reaches a normal terminal condition; timer release alone
            // does not finalize the pre-wakeup result": this cycle's terminal
            // locals (set by whichever outcome — commonly `stop`, via a
            // `stopWhen` that triggered right on the `scheduleWakeup` tool call
            // — broke the step loop above) were only ever PROVISIONAL: the real
            // terminal outcome is now whatever the continuation step(s), run by
            // looping this outer `while` again, produce. Reset every
            // terminal-outcome local before continuing so a continuation that
            // never itself reaches a genuine terminal condition (e.g.
            // `maximumSteps` is already exhausted) falls through to the
            // ordinary `maximum-steps` handling below rather than returning the
            // stale pre-wakeup outcome.
            finishReason = 'maximum-steps';
            errorMessage = undefined;
            abortReason = undefined;
            schemaValidation = undefined;
            output = undefined;
            tripwire = undefined;
            stoppedEarly = false;

            continue;
          } else if (!isFailureOutcome && pendingHumanWait !== undefined) {
            // === F3 — HITL human-input gate (requestHumanInput tool) ===
            // AB-44 — resume agent reasoning with the delivered signal payload,
            // per AB-41's decision record: a delivered signal CONTINUES the same
            // run with one more generation step; it never merely unparks into an
            // immediate return. `ctx.waitForSignal` is itself the checkpointed
            // durable operation — Weft buffers a signal sent before this line is
            // reached and delivers it the instant the workflow arrives here (its
            // buffering guarantee), and a crash either side of this `yield*` is
            // safe: before it, recovery re-issues the same wait; after it (but
            // before the commits below land), recovery re-issues the memoized
            // work below from its checkpoint, never re-consuming the signal or
            // dropping the resumed turn.
            const signalName = pendingHumanWait.signalName;
            const payload = yield* ctx.waitForSignal(signalName);

            // Consumed: clear the hoisted local so a cycle that ends WITHOUT the
            // continuation step re-requesting human input does not re-enter this
            // branch and wait on the same already-delivered signal again. Record
            // the signal name separately for the final result — see
            // `lastHumanWaitSignal`'s declaration above.
            pendingHumanWait = undefined;
            lastHumanWaitSignal = signalName;

            // `deliveredAt` must be a plain, checkpointed value — reading
            // `Date.now()`/`new Date().toISOString()` directly in workflow-body
            // code would be non-deterministic across replay. `ctx.memo` here
            // commits it once and short-circuits to the same value on replay.
            // Keyed by `cursor.step`: a re-park needs at least one more
            // committed step first (this loop's own memo-per-step keys already
            // rely on the same uniqueness), so each park cycle gets its own key.
            const deliveredAt = yield* ctx.memo(
              `signal-delivered-at-${cursor.step}`,
              // eslint-disable-next-line @typescript-eslint/require-await -- ctx.memo requires an async callback; this one has no await of its own.
              async () => new Date().toISOString(),
            );

            const continuationInput = buildSignalContinuationInput(
              signalName,
              payload,
              deliveredAt,
            );
            const renderedMessage = renderSignalContinuation(continuationInput);

            const resumedConversation = Conversation.from(snapshot);
            resumedConversation.appendUserMessage(renderedMessage);
            snapshot = resumedConversation.snapshot();
            yield* ctx.run('saveConversation', { runId, snapshot });

            // AC — "signal delivery alone does not finalize the pre-signal
            // result": this cycle's terminal locals (set by whichever outcome
            // — commonly `stop`, via a `stopWhen` that triggered right on the
            // `requestHumanInput` tool call — broke the step loop above) were
            // only ever PROVISIONAL: the real terminal outcome is now whatever
            // the continuation step(s), run by looping this outer `while` again,
            // produce. Reset every terminal-outcome local before continuing so
            // a continuation that never itself reaches a genuine terminal
            // condition (e.g. `maximumSteps` is already exhausted) falls
            // through to the ordinary `maximum-steps` handling below rather
            // than returning the stale pre-signal outcome.
            finishReason = 'maximum-steps';
            errorMessage = undefined;
            abortReason = undefined;
            schemaValidation = undefined;
            output = undefined;
            tripwire = undefined;
            stoppedEarly = false;

            continue;
          }

          // Neither park primitive is pending (or the outcome was a failure) —
          // this run cycle's outcome is genuinely terminal.
          break;
        }

        ctx.setAttribute('runId', runId);

        return {
          schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
          runId,
          steps: cursor.step,
          content: cursor.lastContent,
          finishReason,
          ...(errorMessage !== undefined ? { errorMessage } : {}),
          ...(abortReason !== undefined ? { abortReason } : {}),
          ...(schemaValidation !== undefined ? { schemaValidation } : {}),
          ...(schemaValidation?.success ? { output } : {}),
          ...(tripwire !== undefined ? { tripwire } : {}),
          // `wakeupNote` reports the note from the LAST `scheduleWakeup` park
          // this run genuinely slept on and woke from — a historical fact
          // recorded only inside the `yield* ctx.sleep(...)` branch above once
          // it has actually resolved (AB-45), so, like `humanWaitSignal`, it
          // is reported regardless of how the run eventually terminates: an
          // outcome the continuation reaches AFTER a real park is not "stale".
          // A `pendingWakeup` still set at THIS point (never consumed) means
          // the run hit a terminal failure before parking — `isFailureOutcome`
          // gated the park block above, so that wakeup never fired and
          // `lastWakeupNote` was never set; no metadata leaks through.
          ...(lastWakeupNote !== undefined ? { wakeupNote: lastWakeupNote } : {}),
          // `humanWaitSignal` reports the LAST signal this run genuinely
          // parked on and was released for — a historical fact recorded only
          // inside the `yield* ctx.waitForSignal(...)` branch above once it
          // has actually resolved, mirroring `wakeupNote` above: it is
          // reported regardless of how the run eventually terminates, since
          // an outcome the continuation reaches AFTER a real park is not
          // "stale".
          ...(lastHumanWaitSignal !== undefined ? { humanWaitSignal: lastHumanWaitSignal } : {}),
        } satisfies AgentRunWorkflowResult;
      })
  );
}
