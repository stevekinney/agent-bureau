import { activity } from '@lostgradient/weft';
import type { ConversationSnapshot } from 'conversationalist';

import type { CheckpointStore } from './checkpoint-store';
import type { RunCursor, StepRecord } from './types';

/** Input carrying only a `runId` — for the read activities. */
export interface RunIdInput {
  runId: string;
}

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
 * Builds the durable storage activities over the given {@link CheckpointStore}.
 *
 * These are the read/commit operations the durable workflow yields to at
 * checkpoint boundaries:
 *
 * - `loadCursor` / `loadConversation` rehydrate a run on resume,
 * - `saveCursor` commits the cheap resume position at every yield,
 * - `saveConversation` / `recordStep` commit the heavier transcript and
 *   per-step record at step boundaries.
 *
 * All inputs/outputs are plain and cloneable — no `Conversation` instance and no
 * closures cross the activity boundary. The store is captured once (it wraps the
 * engine's shared backend), so the activities never need a per-run registry the
 * way tool execution does.
 *
 * The return type is inferred so each activity keeps its precise input/output
 * types for `ctx.run` autocompletion in the workflow body.
 */
export function createStorageActivities(checkpointStore: CheckpointStore) {
  return {
    loadCursor: activity({
      name: 'loadCursor',
      idempotent: true,
      execute: async (input: RunIdInput): Promise<RunCursor | null> =>
        checkpointStore.loadCursor(input.runId),
    }),

    loadConversation: activity({
      name: 'loadConversation',
      idempotent: true,
      execute: async (input: RunIdInput): Promise<ConversationSnapshot | null> =>
        checkpointStore.loadConversation(input.runId),
    }),

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
