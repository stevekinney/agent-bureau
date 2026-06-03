import { workflow } from '@lostgradient/weft';
import type { ToolExecutionResult } from 'armorer';
import { Conversation, isConversation, materializeToolCalls } from 'conversationalist';

import type { CheckpointStore } from './checkpoint-store';
import { getRunDeps } from './deps-registry';
import type { DurableToolResult } from './execute-tool-activity';
import { executeToolActivity } from './execute-tool-activity';
import { createStorageActivities } from './storage-activities';
import type { StepRecord } from './types';

/**
 * The durable agent-run workflow.
 *
 * This is the **additive durable driver** (see the design doc's §5 deviation
 * note): it does NOT refactor `executeLoop`. It re-implements the core
 * generate → tools → checkpoint step cycle directly on the proven durable
 * activities, so a run can resume from the last completed step after a crash.
 * It is opt-in: a bureau wires it only when an engine is present, leaving the
 * rich in-memory `executeLoop` as the default path.
 *
 * @remarks
 * The load-bearing invariant: **no `Conversation` instance is ever a live
 * workflow local across a `yield*`.** Generate runs in-process (durable via
 * checkpoint-not-replay: its result is captured into the plain `snapshot` local
 * before the next yield). A fresh `Conversation.from(snapshot)` is rehydrated
 * inside each no-`yield*` region, mutated, and re-snapshotted; the instance is
 * born and dies between yields. Only plain, cloneable data (`cursor`, `snapshot`,
 * tool-call inputs, `DurableToolResult`s) crosses a checkpoint boundary.
 *
 * Scope (foundation): the durable path covers generate → tool execution →
 * step checkpoint and resume-from-step-N. It does NOT yet cover the full
 * `executeLoop` surface. Uncovered behavior is enumerated as TODO seams:
 *
 * TODO(weft-integration): #13 converge executeLoop and this driver onto one
 *   shared step implementation (the deferred loop refactor).
 * TODO(weft-integration): #1 durable retry counters (onError/schema-retry loops).
 * TODO(weft-integration): #3 context compaction as a compactContext activity.
 * TODO(weft-integration): #11 classify hooks by side-effect-ness for resume
 *   re-emit; this driver runs no per-step hooks yet.
 */

/** Input to the durable agent-run workflow. */
export interface AgentRunWorkflowInput {
  runId: string;
  /** The first user message to seed a brand-new run (ignored on resume). */
  prompt?: string;
  /** Safety bound on step count, mirroring `RunOptions.maximumSteps`. */
  maximumSteps?: number;
}

/** Plain, cloneable summary returned when the durable run completes. */
export interface AgentRunWorkflowResult {
  runId: string;
  steps: number;
  content: string;
  finishReason: 'stop-condition' | 'maximum-steps';
}

const DEFAULT_MAXIMUM_STEPS = 25;

/**
 * Convert the workflow's durable tool results back into the
 * {@link ToolExecutionResult} shape `Conversation.appendToolResults` expects.
 * The durable projection is a strict subset, so this is a widening with the
 * runtime-only fields (`result`) reconstructed from `content`.
 */
function toToolExecutionResults(results: DurableToolResult[]): ToolExecutionResult[] {
  return results.map((result) => ({
    callId: result.callId,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    outcome: result.outcome,
    content: result.content,
    result: result.content,
    ...(result.error ? { error: result.error } : {}),
  }));
}

/**
 * Builds the durable `agentRun` workflow over the given {@link CheckpointStore}.
 * The storage activities are created from the same store the engine persists to,
 * so the workflow's reads and writes share one backend.
 */
export function createRunWorkflow(checkpointStore: CheckpointStore) {
  const storage = createStorageActivities(checkpointStore);

  return workflow({ name: 'agentRun' })
    .activities({
      executeTool: executeToolActivity,
      loadCursor: storage.loadCursor,
      loadConversation: storage.loadConversation,
      saveCursor: storage.saveCursor,
      saveConversation: storage.saveConversation,
      recordStep: storage.recordStep,
    })
    .execute(async function* (ctx, input: AgentRunWorkflowInput) {
      const { runId } = input;
      const maximumSteps = input.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;

      // CRITICAL: `getRunDeps` is resolved ONLY inside no-`yield*` regions, never
      // held as a local across a yield. `deps` holds non-serializable closures
      // (generate, toolbox); keeping it live across a checkpoint would either
      // fail validateCloneable or be lost on resume. Same rule as Conversation:
      // born and used between yields, never crossing one. On cross-process
      // recovery the deps registry must be re-injected first (seam #5).

      // DURABLE LOCALS — both plain/cloneable. Resume rehydrates them from store.
      let cursor = (yield* ctx.run('loadCursor', { runId })) ?? { step: 0 };
      let snapshot = yield* ctx.run('loadConversation', { runId });

      // Seed a fresh run's conversation with the prompt, then persist it so a
      // resume before step 0 completes still sees the seeded transcript.
      if (snapshot === null) {
        const options = getRunDeps(runId).options;
        const seeded = isConversation(options.conversation)
          ? options.conversation
          : new Conversation(options.conversation);
        if (input.prompt !== undefined) {
          seeded.appendUserMessage(input.prompt);
        }
        snapshot = seeded.snapshot();
        yield* ctx.run('saveConversation', { runId, snapshot });
      }

      let lastContent = '';
      let finishReason: AgentRunWorkflowResult['finishReason'] = 'maximum-steps';

      while (cursor.step < maximumSteps) {
        // === IN-MEMORY generate region (no yield*). Both the Conversation
        // instance AND the deps closures are born and die here, before the next
        // yield — so neither ever crosses a checkpoint boundary. ===
        const generated = await (async () => {
          const deps = getRunDeps(runId);
          const conversation = Conversation.from(snapshot);
          const response = await deps.options.generate({
            conversation,
            step: cursor.step,
            // Use the typed RunOptions toolbox for the generate context; the
            // registry's `deps.toolbox` (widened to AnyToolbox) is used only by
            // the executeTool activity for dispatch.
            toolbox: deps.options.toolbox,
          });
          lastContent = response.content;
          if (response.content && !response.messageAppended) {
            conversation.appendAssistantMessage(response.content, response.metadata);
          }
          const toolCalls = materializeToolCalls(response.toolCalls);
          if (toolCalls.length > 0) {
            conversation.appendToolCalls(toolCalls);
          }
          return { toolCalls, conversationSnapshot: conversation.snapshot() };
        })();

        snapshot = generated.conversationSnapshot;

        // === Durable commit of the assistant turn BEFORE any tool side effect.
        // generate does not re-run on a crash after this point. ===
        yield* ctx.run('saveConversation', { runId, snapshot });

        // === Durable tool execution — the only side-effect activity. ===
        const toolResults: DurableToolResult[] = [];
        for (const toolCall of generated.toolCalls) {
          const result = yield* ctx.run(
            'executeTool',
            { runId, toolCall },
            {
              idempotencyKey: toolCall.id,
              retry: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2 },
            },
          );
          toolResults.push(result);
        }

        // === IN-MEMORY tail: append tool results. Fresh instance again. ===
        if (toolResults.length > 0) {
          const conversation = Conversation.from(snapshot);
          conversation.appendToolResults(toToolExecutionResults(toolResults));
          snapshot = conversation.snapshot();
        }

        // === Durable step-boundary commit. ===
        const record: StepRecord = {
          step: cursor.step,
          content: lastContent,
          toolCalls: generated.toolCalls,
          results: toToolExecutionResults(toolResults),
          final: generated.toolCalls.length === 0,
        };
        yield* ctx.run('recordStep', { runId, record });
        yield* ctx.run('saveConversation', { runId, snapshot });

        cursor = { step: cursor.step + 1 };
        yield* ctx.run('saveCursor', { runId, cursor });

        // Stop condition (foundation): no tool calls means the agent is done.
        // TODO(weft-integration): honor the full RunOptions.stopWhen predicates
        //   (loop.ts evaluateStopConditions) instead of only the no-tool-calls case.
        if (generated.toolCalls.length === 0) {
          finishReason = 'stop-condition';
          break;
        }
      }

      ctx.setAttribute('runId', runId);

      return {
        runId,
        steps: cursor.step,
        content: lastContent,
        finishReason,
      } satisfies AgentRunWorkflowResult;
    });
}
