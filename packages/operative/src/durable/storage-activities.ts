import { activity } from '@lostgradient/weft';
import type { ConversationSnapshot } from 'conversationalist';

import type { CheckpointStore } from './checkpoint-store';
import type { RunCursor, StepRecord } from './types';

/** Input for the cursor write activity. */
export interface SaveCursorInput {
  runId: string;
  cursor: RunCursor;
}

/** Input for the conversation snapshot write activity. */
export interface SaveConversationInput {
  runId: string;
  snapshot: ConversationSnapshot;
}

/** Input for the step-record write activity. */
export interface RecordStepInput {
  runId: string;
  record: StepRecord;
}

/**
 * Builds the durable storage WRITE activities over the given {@link CheckpointStore}.
 *
 * These commit run state at checkpoint boundaries so the {@link import('./active-run-adapter').createDurableActiveRun}
 * adapter can reconstruct the `RunResult` after completion:
 *
 * - `saveCursor` commits the resume position (step + accumulators) every yield,
 * - `saveConversation` / `recordStep` commit the transcript and per-step record.
 *
 * There are deliberately NO read activities. The workflow's own resume position
 * is Weft's checkpointed locals + `ctx.memo` results, NOT a re-read of this store
 * — re-reading via an activity is wrong because Weft caches the activity's first
 * result and replays that stale value on recovery. These writes feed the adapter,
 * not the workflow's resume.
 *
 * All inputs are plain and cloneable — no `Conversation` instance and no closures
 * cross the activity boundary. The store is captured once (it wraps the engine's
 * shared backend), so the activities never need a per-run registry.
 *
 * The return type is inferred so each activity keeps its precise input/output
 * types for `ctx.run` autocompletion in the workflow body.
 */
export function createStorageActivities(checkpointStore: CheckpointStore) {
  return {
    saveCursor: activity({
      name: 'saveCursor',
      idempotent: true,
      execute: async (input: SaveCursorInput): Promise<void> =>
        checkpointStore.saveCursor(input.runId, input.cursor),
    }),

    saveConversation: activity({
      name: 'saveConversation',
      idempotent: true,
      execute: async (input: SaveConversationInput): Promise<void> =>
        checkpointStore.saveConversation(input.runId, input.snapshot),
    }),

    recordStep: activity({
      name: 'recordStep',
      idempotent: true,
      execute: async (input: RecordStepInput): Promise<void> =>
        checkpointStore.saveStep(input.runId, input.record),
    }),
  };
}
