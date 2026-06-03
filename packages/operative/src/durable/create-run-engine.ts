import type { AnyWorkflowDefinition } from '@lostgradient/weft';
import { Engine } from '@lostgradient/weft';
import type { Storage } from '@lostgradient/weft/storage';
import { textValueStore } from '@lostgradient/weft/storage';

import type { CheckpointStore } from './checkpoint-store';
import { createCheckpointStore } from './checkpoint-store';
import { createStorageActivities } from './storage-activities';

/**
 * Options for {@link createRunEngine}.
 */
export interface CreateRunEngineOptions {
  /**
   * The raw Weft {@link Storage} backend the engine persists checkpoints to.
   *
   * This MUST be the same backend the rest of agent-bureau wraps with
   * `textValueStore` (sessions, cache, identity), so durable run state and
   * application data share one store — Weft requires one engine per durable
   * store. Use a persistent backend (`SQLiteStorage`) when durability matters;
   * `MemoryStorage` loses checkpoints with the process.
   */
  storage: Storage;

  /**
   * The durable agent-run workflow definition (`run-workflow.ts`'s `agentRun`).
   * Injected rather than imported so the engine wiring can be built and tested
   * independently of the workflow body (which depends on the loop refactor).
   */
  runWorkflow: AnyWorkflowDefinition;

  /**
   * Recover in-flight workflows on boot. Defaults to `true` (Weft's default):
   * a fresh engine resumes any `agentRun` workflows a previous process left
   * mid-flight. Pass `false` for isolated tests.
   */
  recover?: boolean;

  /**
   * A pre-built {@link CheckpointStore}. When omitted, one is created over a
   * `textValueStore` view of `storage`. Inject one to share the exact store the
   * rest of composition already built.
   */
  checkpointStore?: CheckpointStore;
}

/**
 * A durable run engine, widened over its workflow/activity type parameters.
 *
 * `Engine`'s generics are invariant, so the precisely-typed engine
 * `Engine.create` returns is not assignable to the bare `Engine` default. The
 * durable run layer only ever calls `engine.start(name, input)` and disposal —
 * it never inspects the registered workflow/activity types — so widening here is
 * safe and matches gateway's `Toolbox<any>` convention for invariant generics.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Engine generics are invariant; the run layer never inspects the type parameters.
export type AnyRunEngine = Engine<any, any>;

/**
 * The durable run engine plus the checkpoint store it was built with, so callers
 * can read/write checkpoints through the same view the activities use.
 */
export interface RunEngine {
  engine: AnyRunEngine;
  checkpointStore: CheckpointStore;
}

/**
 * Builds the durable run {@link Engine}: registers the `agentRun` workflow and
 * the storage activities (load/save cursor, conversation, and step records),
 * wired to a single durable backend. Tool execution is NOT an activity — it runs
 * in-process inside `runStep`, the same code path the in-memory loop uses.
 *
 * @remarks
 * `recover` defaults to `true`, so on boot the engine resumes any `agentRun`
 * workflows a previous process left in flight. Those recovered runs cannot
 * advance until their non-serializable deps are re-injected into the
 * {@link import('./deps-registry').registerRunDeps deps registry} — see the
 * recovery seam (#5) in the design doc.
 *
 * TODO(weft-integration): tune `history.maxEvents` / checkpoint size warning
 * threshold once long-run checkpoint sizes are measured (design seam #12).
 */
export async function createRunEngine(options: CreateRunEngineOptions): Promise<RunEngine> {
  const checkpointStore =
    options.checkpointStore ?? createCheckpointStoreFromStorage(options.storage);
  const storageActivities = createStorageActivities(checkpointStore);

  const engine = await Engine.create({
    storage: options.storage,
    recover: options.recover ?? true,
    workflows: { agentRun: options.runWorkflow },
    activities: {
      loadCursor: storageActivities.loadCursor,
      loadConversation: storageActivities.loadConversation,
      saveCursor: storageActivities.saveCursor,
      saveConversation: storageActivities.saveConversation,
      recordStep: storageActivities.recordStep,
    },
  });

  return { engine, checkpointStore };
}

/**
 * Build a {@link CheckpointStore} over a `textValueStore` view of a raw
 * {@link Storage}. The view does NOT dispose the underlying backend on close —
 * the engine owns the backend's lifecycle.
 */
function createCheckpointStoreFromStorage(storage: Storage): CheckpointStore {
  return createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
}
