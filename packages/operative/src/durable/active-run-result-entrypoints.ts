import type { RuntimeServices } from '@lostgradient/lifecycle';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';

import { type RunOptions, type RunResult } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import { SCHEDULER_ORIGIN_TAG } from './active-run-constants';
import type { RecoveredRunHandle } from './active-run-event-surface';
import { reconstructRunResult } from './active-run-result-reconstruction';
import { normalizeAgentRunWorkflowResult } from './run-workflow-result';

export async function resumeDurableRunResult(
  context: DurableActiveRunContext,
  runId: string,
  // AB-321: optional — a caller that already resolved a `RuntimeServices`
  // (e.g. the scheduler's own composed instance) forwards it here so a
  // reconstructed fallback conversation reads through the SAME runtime
  // rather than a fresh default; omitting it preserves prior behavior.
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): Promise<RunResult> {
  const handle = await context.engine.resume(runId);
  const summary = normalizeAgentRunWorkflowResult(await (handle as RecoveredRunHandle).result());
  const { result } = await reconstructRunResult(context, runId, summary, runtime);
  return result;
}

/** Options for {@link startDurableRunResult}. */
export interface StartDurableRunResultOptions {
  /** Stable id for the run; also the durable workflow id (suspend/resume key). */
  runId: string;
  /** The owning session id, carried in the durable input for boot recovery. */
  sessionId: string;
  /**
   * The name of the agent running this workflow (F2 — RunRef.agentName).
   * Defaults to `options.agentName ?? ''` when omitted.
   */
  agentName?: string | undefined;
  /** The run behavior (generate, toolbox, hooks, stopWhen, …). */
  options: RunOptions;
  /** First user message to seed a brand-new run. */
  prompt?: string | undefined;
  /** Abort signal for the run (the scheduler's combined signal). */
  signal?: AbortSignal | undefined;
  /**
   * Tags for the durable workflow start (e.g. {@link SCHEDULER_ORIGIN_TAG}). The
   * scheduler stamps its origin tag here so boot recovery can distinguish these
   * runs from session runs and the boot sweep can find suspended residue.
   */
  tags?: string[] | undefined;
}

/**
 * START a fresh durable run and return a `RunResult` promise that settles when it
 * completes — the HOOKS-FREE, RESULT-ONLY sibling of {@link resumeDurableRunResult}
 * for the scheduler's preemptable durable dispatch.
 *
 * Why this exists instead of `createDurableActiveRun`: that adapter fires the run's
 * `options.hooks` (`onRunStart`/`onRunComplete`) via the run-lifecycle whenever
 * `handle.result()` resolves. But `engine.suspend` does NOT settle that handle —
 * so on a preempt→resume, the ORIGINAL `createDurableActiveRun` driver stays alive
 * and fires `onRunComplete` a SECOND time when the resumed run finally completes,
 * even though the resume dispatch owns task completion (committee/Bugbot:
 * "suspended run duplicates lifecycle hooks"). Driving a preemptable run with this
 * result-only function — symmetric with the resume path — means NEITHER the
 * original nor the resume driver fires run hooks, so they cannot double-fire. The
 * scheduler is the single lifecycle owner for scheduled tasks (its own
 * Task*Events + `task.onComplete` fire exactly once); run-level `options.hooks` do
 * not fire for a preemptable scheduler run, by design.
 *
 * Step-level events still flow: the emitter is passed in `services` so `runStep`
 * (inline mode) dispatches to it, exactly as the fresh `createDurableActiveRun`
 * path does. Failure PROPAGATES (rejects) so a failed run surfaces as a failed
 * task.
 */
export async function startDurableRunResult(
  context: DurableActiveRunContext,
  durableRun: StartDurableRunResultOptions,
): Promise<RunResult> {
  const { runId, sessionId, options, prompt, signal, tags } = durableRun;
  // F2: resolve agentName for durable input — explicit > RunOptions.agentName > ''.
  const agentName = durableRun.agentName ?? options.agentName ?? '';
  // AB-321: resolved exactly once here, matching every other durable entry
  // point's own `options.runtime ?? createDefaultRuntimeServices()`.
  const runtime = options.runtime ?? createDefaultRuntimeServices();

  // 'start-new' is a DATA-LOSS policy (it purges a prior terminal run under the
  // same id) and must be scoped to runs that legitimately reuse an id — i.e.
  // SCHEDULER-ORIGIN runs, which reuse a synthetic, counter-suffixed id that can
  // collide with a TERMINAL prior run after a crash+restart. For any other
  // durable run a terminal-id collision is a genuine error to surface, NOT to
  // silently overwrite, so we only opt into 'start-new' when the scheduler tag is
  // present. NOTE: 'start-new' covers only TERMINAL conflicts — a `suspended`
  // prior run is not terminal, so id-collision with suspended residue is prevented
  // by the boot sweep (sweepSuspendedSchedulerRuns), not by this policy.
  const isSchedulerOrigin = tags?.includes(SCHEDULER_ORIGIN_TAG) ?? false;

  const handle = await context.engine.start(
    'agentRun',
    { runId, sessionId, agentName, prompt, maximumSteps: options.maximumSteps },
    {
      id: runId,
      ...(tags ? { tags } : {}),
      ...(isSchedulerOrigin ? { onTerminalConflict: 'start-new' as const } : {}),
      services: {
        // AB-321: snapshots the SAME resolved `runtime` this function reads
        // for `reconstructRunResult` below, so the workflow-side run and this
        // reconstruction agree on one runtime instance rather than each
        // independently defaulting to its own.
        options: { ...options, signal, runtime },
        toolbox: options.toolbox,
        // No emitter: a preemptable scheduler run has no run-level event surface
        // (the scheduler drives Task*Events itself). Step events simply do not
        // fire — `emitter` is optional in DurableRunDeps and runStep accepts
        // `undefined`.
      },
    },
  );
  const summary = normalizeAgentRunWorkflowResult(await (handle as RecoveredRunHandle).result());
  const { result } = await reconstructRunResult(context, runId, summary, runtime);
  return result;
}

/**
 * Drive a REATTACHED recovered run: await the already-running handle, reconstruct
 * the `RunResult` from the checkpoint, and fire ONLY the terminal lifecycle (no
 * start lifecycle — seam #11). On a rejecting handle, stay write-free: the
 * resolver (services-unavailable → engine-failed) or the teardown
 * (`EngineDisposedError`) already owns that session's terminal status.
 */
