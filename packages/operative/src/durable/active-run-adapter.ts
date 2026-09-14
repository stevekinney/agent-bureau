import type { OperativeEventEmitter } from '../events';
import type { StallWatchdogClock } from '../liveness';
import type { RunOptions } from '../types';
import type { CheckpointStore } from './checkpoint-store';
import type { RegistryAgnosticEngine } from './create-run-engine';
import type { DurableRunDeps } from './types';

/** Dependencies the adapter needs from bureau composition. */
export interface DurableActiveRunContext {
  engine: RegistryAgnosticEngine;
  checkpointStore: CheckpointStore;
}

/** Options for a durable ActiveRun. */
export interface DurableActiveRunOptions {
  runId: string;
  sessionId: string;
  agentName?: string;
  options: RunOptions;
  prompt?: string;
  emitter?: OperativeEventEmitter;
  onServices?: (services: DurableRunDeps) => void;
  livenessClock?: StallWatchdogClock;
  livenessOwner?: string;
}
