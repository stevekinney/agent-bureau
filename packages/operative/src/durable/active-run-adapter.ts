import type { OperativeEventEmitter } from '../events';
import type { StallWatchdogClock } from '../liveness';
import type { CleanupAcknowledgement, RunOptions } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import type { RegistryAgnosticEngine } from './create-run-engine';
import type { DurableRunDeps } from './types';

/**
 * A composer-owned cleanup step run once a durable run has reached its
 * terminal state, folded into that run's `closed()` acknowledgement
 * (COR-625). Bureau supplies checkpoint retention here; the adapter itself
 * knows nothing about what the step does.
 *
 * The step's acknowledgement only ever DOWNGRADES the run's own: a step that
 * reports `completed` or `not-required` leaves the run's outcome untouched,
 * while `unresolved` or `failed` replaces it. Returning the step's result
 * outright would flip every durable run under the default `'keep-all'`
 * retention from `completed` to `not-required` — the run's cleanup did
 * complete, and the retention step having had nothing to prune is a separate
 * fact that belongs in the composer's own audit record, not in the run's
 * acknowledgement.
 *
 * It must never reject: `closed()` never rejects, and a rejection here would
 * be classified as the RUN's teardown failure rather than the step's. The
 * hook owns its own error classification.
 */
export type DurableTerminalCleanup = (runId: string) => Promise<CleanupAcknowledgement>;

/** Dependencies the adapter needs from bureau composition. */
export interface DurableActiveRunContext {
  engine: RegistryAgnosticEngine;
  checkpointStore: CheckpointStore;
  /**
   * Optional terminal-cleanup step (COR-625). Omitted — the default for any
   * caller composing a durable run outside bureau — `closed()` behaves
   * exactly as it did before this hook existed.
   */
  terminalCleanup?: DurableTerminalCleanup | undefined;
}

/** Options for a durable ActiveRun. */
export interface DurableActiveRunOptions {
  runId: string;
  sessionId: string;
  agentName?: string | undefined;
  options: RunOptions;
  prompt?: string | undefined;
  emitter?: OperativeEventEmitter | undefined;
  onServices?: ((services: DurableRunDeps) => void) | undefined;
  livenessClock?: StallWatchdogClock | undefined;
  livenessOwner?: string | undefined;
}
