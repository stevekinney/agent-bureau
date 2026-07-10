import {
  appendAssistantMessage,
  appendUserMessage,
  type ConversationHistory,
  createConversation,
} from '@lostgradient/cinder/chat';

import type { RunSummary, ServerFrame } from '../../types';
import {
  INITIAL_TOOL_ACTIVITY_STATE,
  reduceToolActivity,
  type ToolActivityAction,
  type ToolActivityState,
} from './tool-activity';

export interface CreateChatStoreOptions {
  /** Called with the run summary returned when a message starts a new run. */
  onRunCreated?: (run: RunSummary) => void;
  /** Subscribes the live transport to a run id. */
  subscribe: (runId: string) => void;
  /** Unsubscribes the live transport from a run id. */
  unsubscribe: (runId: string) => void;
  /**
   * Called when a live frame suggests the active run's review-queue state
   * (AB-20) may have changed — a `step.completed` (a tool call may now be
   * parked on `needs_approval`) or `multiagent.human-wait.parked` (a durable
   * run parked on `requestHumanInput`) event. Mirrors exactly the two action
   * types `webhook-notifier.ts`'s `fireReview` listens for, so the chat
   * surface refreshes its pending-review view on the same triggers the
   * webhook notifier already treats as authoritative. The reviews store has
   * no live feed of its own (AB-20 doc comment on `use-reviews.svelte.ts`),
   * so this is what makes an in-progress chat notice a newly-parked run
   * without waiting for the next poll tick.
   */
  onHumanInputRequested?: () => void;
}

/**
 * Reactive store backing the chat page.
 *
 * The React `ChatMessage[]` becomes a cinder {@link ConversationHistory}
 * snapshot built with the chat builders, so it feeds the `Chat` component's
 * `conversation` prop directly. Streaming text feeds `Chat.streaming` /
 * `streamingStatus`. The React `runIdRef`/`sessionIdRef`/`streamingContentRef`
 * mirrors collapse: `runId`/`sessionId` are `$state` (UI-facing) read directly
 * inside `handleMessage`; `streamingContent` is a plain local since it never
 * drives UI on its own (the reactive surface is `streamingAssistantContent`).
 */
export interface ChatStore {
  /** The conversation snapshot to render. Reactive — read directly, never destructure. */
  readonly conversation: ConversationHistory;
  /** The active run id, once a message has been sent. */
  readonly runId: string | undefined;
  /** True while a send request is in flight. */
  readonly sending: boolean;
  /** The latest send/run error, if any. */
  readonly error: string | undefined;
  /** The session id threaded across sends, once known. */
  readonly sessionId: string | undefined;
  /** The accumulated streaming assistant text ('' when idle). */
  readonly streamingAssistantContent: string;
  /** The ordered tool-activity log lines. */
  readonly toolActivity: string[];
  /** Posts a user message, starts a run, and subscribes to its frames. */
  send: (message: string) => Promise<void>;
  /** Folds a live server frame into the chat state. */
  handleMessage: (frame: ServerFrame) => void;
}

/**
 * Renders an arbitrary tool-argument value into a short human-readable summary
 * for the tool-activity log, tolerating non-serializable inputs.
 */
function summarizeToolArguments(argumentsValue: unknown): string {
  if (argumentsValue === undefined) {
    return '';
  }

  if (
    typeof argumentsValue === 'string' ||
    typeof argumentsValue === 'number' ||
    typeof argumentsValue === 'boolean' ||
    typeof argumentsValue === 'bigint'
  ) {
    return String(argumentsValue);
  }

  if (argumentsValue instanceof Error) {
    return argumentsValue.message;
  }

  if (typeof argumentsValue === 'symbol') {
    return argumentsValue.description ? `Symbol(${argumentsValue.description})` : 'Symbol()';
  }

  try {
    return JSON.stringify(argumentsValue);
  } catch {
    return Object.prototype.toString.call(argumentsValue);
  }
}

/**
 * Creates a {@link ChatStore}. Live-transport wiring is injected via
 * {@link CreateChatStoreOptions} so the store stays transport-agnostic.
 */
export function createChatStore({
  onRunCreated,
  subscribe,
  unsubscribe,
  onHumanInputRequested,
}: CreateChatStoreOptions): ChatStore {
  let conversation = $state<ConversationHistory>(createConversation());
  let runId = $state<string | undefined>(undefined);
  let sessionId = $state<string | undefined>(undefined);
  let sending = $state(false);
  let error = $state<string | undefined>(undefined);
  let streamingAssistantContent = $state('');
  let toolActivityState = $state<ToolActivityState>(INITIAL_TOOL_ACTIVITY_STATE);

  // Mirror of the streamed text used only inside `handleMessage` to decide the
  // committed assistant message; never read by the UI, so a plain local.
  let streamingContent = '';

  function dispatchToolActivity(action: ToolActivityAction): void {
    toolActivityState = reduceToolActivity(toolActivityState, action);
  }

  async function send(message: string): Promise<void> {
    sending = true;
    error = undefined;
    streamingAssistantContent = '';
    streamingContent = '';
    dispatchToolActivity({ type: 'reset' });
    conversation = appendUserMessage(conversation, message);

    try {
      const response = await fetch('/api/v1/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          sessionId,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        error = errorBody || `Request failed with status ${response.status}`;
        return;
      }

      const data = (await response.json()) as RunSummary;

      if (runId) {
        unsubscribe(runId);
      }

      subscribe(data.id);
      runId = data.id;
      sessionId = data.sessionId;
      onRunCreated?.(data);
    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : 'Network error';
    } finally {
      sending = false;
    }
  }

  function handleMessage(frame: ServerFrame): void {
    if (!('runId' in frame) || frame.runId !== runId) return;

    switch (frame.type) {
      case 'event': {
        if (frame.event === 'run.completed') {
          const detail = frame.detail as { content?: string };
          const assistantContent = streamingContent || detail.content;
          if (assistantContent) {
            conversation = appendAssistantMessage(conversation, assistantContent);
          }
          streamingContent = '';
          streamingAssistantContent = '';
        }

        if (frame.event === 'run.error') {
          const detail = frame.detail as { error?: string };
          error = detail.error ?? 'Run failed';
          streamingContent = '';
          streamingAssistantContent = '';
        }

        if (frame.event === 'run.aborted') {
          streamingContent = '';
          streamingAssistantContent = '';
        }

        if (frame.event === 'step.completed' || frame.event === 'multiagent.human-wait.parked') {
          onHumanInputRequested?.();
        }

        break;
      }
      case 'stream:text-delta':
        streamingContent = frame.accumulated;
        streamingAssistantContent = frame.accumulated;
        break;
      case 'stream:tool-call-start':
        dispatchToolActivity({
          type: 'start',
          blockId: frame.blockId,
          message: `Calling ${frame.toolName}`,
        });
        break;
      case 'stream:tool-call-delta':
        dispatchToolActivity({
          type: 'update',
          blockId: frame.blockId,
          message: `${frame.toolName}: ${frame.partialArgs}`,
        });
        break;
      case 'stream:tool-call-complete':
        dispatchToolActivity({
          type: 'complete',
          blockId: frame.blockId,
          message: `${frame.toolName} completed ${summarizeToolArguments(frame.arguments)}`.trim(),
        });
        break;
      case 'subscribed':
      case 'unsubscribed':
      case 'stream:complete':
      case 'stream:error':
        break;
    }
  }

  return {
    get conversation() {
      return conversation;
    },
    get runId() {
      return runId;
    },
    get sending() {
      return sending;
    },
    get error() {
      return error;
    },
    get sessionId() {
      return sessionId;
    },
    get streamingAssistantContent() {
      return streamingAssistantContent;
    },
    get toolActivity() {
      return [...toolActivityState.entries];
    },
    send,
    handleMessage,
  };
}
