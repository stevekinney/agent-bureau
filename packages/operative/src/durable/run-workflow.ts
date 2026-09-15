import { workflow } from '@lostgradient/weft';
import { Conversation, isConversation } from 'conversationalist';
import { createDefaultRuntimeServices } from 'lifecycle';

import { type AgentRunErrorCode, type AgentRunErrorKind, toAgentRunError } from '../errors';
import { RunErrorEvent } from '../events';
import { DEFAULT_MAXIMUM_STEPS } from '../run-step';
import type { FinishReason } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import {
  type AgentRunWorkflowInput,
  type CreateRunWorkflowOptions,
  initialCursor,
  runDepsFrom,
} from './run-workflow-input';
import { runWorkflowPark, type WorkflowParkState } from './run-workflow-park';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  type AgentRunWorkflowResult,
  classifyErrorFinishReason,
  serializeError,
} from './run-workflow-result';
import { runStepMemo } from './run-workflow-step';
import { isScheduledAgentRunInput, type ScheduledAgentRunInput } from './schedule-agent';
import { createStorageActivities } from './storage-activities';
import type { PendingHumanWait, PendingWakeup, RunCursor } from './types';
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
            : // AB-321: forwards the resolved runtime into the seeded
              // Conversation's own environment seam.
              new Conversation(options.conversation, {
                runtime: options.runtime ?? createDefaultRuntimeServices(),
              });
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
        let errorKind: AgentRunErrorKind | undefined;
        let errorCode: AgentRunErrorCode | undefined;
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
            const stepIndex = cursor.step;
            const carriedAccumulators = {
              totalUsage: cursor.totalUsage,
              lastContent: cursor.lastContent,
              schemaAttempts: cursor.schemaAttempts,
              lastAppliedConfigVersion: cursor.lastAppliedConfigVersion,
            };
            const stepResult = yield* runStepMemo(
              ctx,
              snapshot,
              stepIndex,
              carriedAccumulators,
              runId,
            );

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
              errorKind = stepResult.errorKind;
              errorCode = stepResult.errorCode;
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
              // AB-321: forwards the resolved runtime — see the identical
              // per-step rehydration above.
              const conversation = Conversation.from(snapshot, {
                runtime: deps.options.runtime ?? createDefaultRuntimeServices(),
              });
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
                const runError = toAgentRunError(error, { kind: 'policy' });
                return {
                  kind: 'error' as const,
                  errorMessage: serializeError(error),
                  errorFinishReason: classifyErrorFinishReason(error),
                  errorKind: runError.kind,
                  errorCode: runError.code,
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
              errorKind = tail.errorKind;
              errorCode = tail.errorCode;
            }
          }

          const parkState: WorkflowParkState = {
            snapshot,
            cursor,
            finishReason,
            errorMessage,
            abortReason,
            schemaValidation,
            output,
            tripwire,
            stoppedEarly,
            pendingWakeup,
            pendingHumanWait,
            lastWakeupNote,
            lastHumanWaitSignal,
            runId,
          };
          const continued = yield* runWorkflowPark(ctx, parkState);
          ({
            snapshot,
            cursor,
            finishReason,
            errorMessage,
            abortReason,
            schemaValidation,
            output,
            tripwire,
            stoppedEarly,
            pendingWakeup,
            pendingHumanWait,
            lastWakeupNote,
            lastHumanWaitSignal,
          } = parkState);
          if (continued) continue;
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
          ...(errorKind !== undefined ? { errorKind } : {}),
          ...(errorCode !== undefined ? { errorCode } : {}),
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
