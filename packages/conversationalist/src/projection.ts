import { createConversationHistory } from './conversation/index';
import { ensureConversationSafe } from './conversation/validation';
import { createPIIRedaction } from './plugins/pii-redaction';
import type { ConversationHistory, Message, MessageInput } from './types';

export type ProjectionEventIdentity = string | number;

export type ProjectionReducerContext<Event, State> = {
  readonly conversation: ConversationHistory;
  readonly event: Event;
  readonly events: readonly Event[];
  readonly index: number;
  readonly state: State;
};

export type ProjectionReducerResult<State> =
  | ConversationHistory
  | {
      conversation: ConversationHistory;
      state: State;
    };

export type ProjectionReducer<Event, State> = (
  context: ProjectionReducerContext<Event, State>,
) => ProjectionReducerResult<State>;

export type ProjectionApplyOptions = {
  /**
   * Stable identity for the cumulative log being projected. Pass a session id,
   * run id, or stream id when reusing one projection instance across multiple
   * independent logs whose event ids can collide.
   */
  logKey?: ProjectionEventIdentity;
};

type ProjectionBaseOptions<Event, State> = {
  /**
   * The empty projection state used before the first event and after a
   * divergent event log is detected.
   */
  seed?: ConversationHistory;
  /**
   * Returns the stable append-log identity for an event. Use durable event ids,
   * sequence numbers, or another value that survives reactive proxy boundaries.
   */
  identify: (event: Event, index: number) => ProjectionEventIdentity;
  /**
   * Applies one event to the current conversation projection.
   */
  reduce: ProjectionReducer<Event, State>;
};

export type StatelessProjectionOptions<Event> = ProjectionBaseOptions<Event, undefined> & {
  initialState?: undefined;
};

export type StatefulProjectionOptions<Event, State> = ProjectionBaseOptions<Event, State> & {
  /**
   * Caller state owned by the projection builder. Use this for active
   * streaming message ids, streaming accumulators, or other reducer-local cursors
   * that must survive across prefix-extension calls and reset on divergence.
   */
  initialState: State | (() => State);
};

export type ProjectionOptions<Event, State = undefined> = [State] extends [undefined]
  ? StatelessProjectionOptions<Event>
  : StatefulProjectionOptions<Event, State>;

export type Projection<Event> = {
  /**
   * Applies a cumulative append-only event log. Prefix extensions process only
   * the new tail; divergent logs reset to the seed and refold from the start.
   */
  apply(events: readonly Event[], options?: ProjectionApplyOptions): void;
  /** Resets the projection to its seed, clearing processed identities and state. */
  reset(): void;
  /** Returns the current immutable conversation projection. */
  snapshot(): ConversationHistory;
  /** Number of events from the latest accepted log that have been processed. */
  readonly processedCount: number;
};

export type PublicConversationProjectionOptions = {
  /** Applies additional domain-specific redaction after the package's mandatory default rules. */
  redactText?: ((text: string) => string) | undefined;
};

function projectPublicContent(
  content: Message['content'],
  redactText: (text: string) => string,
): MessageInput['content'] {
  if (typeof content === 'string') return redactText(content);

  return content.flatMap((part) => {
    if (part.type !== 'text') return [];
    return [{ type: 'text' as const, text: redactText(part.text) }];
  });
}

/**
 * Creates a browser- and SSR-safe transcript projection.
 *
 * The projection is deliberately lossy: hidden messages, conversation and message metadata,
 * provider-private reasoning, tool calls and results, citations, token usage, document/image
 * references, container ids, managed-asset grants, and internal instruction roles are excluded.
 * Only user and assistant text cross the server-to-client boundary, with common personal data and
 * credentials redacted.
 */
export function createPublicConversationProjection(
  conversation: ConversationHistory,
  options: PublicConversationProjectionOptions = {},
): ConversationHistory {
  const redactByDefault = createPIIRedaction();
  const customRedaction = options.redactText;
  const redactText = customRedaction
    ? (text: string) => customRedaction(redactByDefault(text))
    : redactByDefault;
  const messages: Record<string, Message> = {};
  const ids: string[] = [];

  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (!message || message.hidden || (message.role !== 'user' && message.role !== 'assistant')) {
      continue;
    }

    ids.push(id);
    messages[id] = {
      id: message.id,
      role: message.role,
      content: projectPublicContent(message.content, redactText),
      position: ids.length - 1,
      createdAt: message.createdAt,
      metadata: {},
      hidden: false,
    };
  }

  return ensureConversationSafe({
    schemaVersion: conversation.schemaVersion,
    id: conversation.id,
    ...(conversation.title !== undefined ? { title: redactText(conversation.title) } : {}),
    status: conversation.status,
    metadata: {},
    ids,
    messages,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  });
}

function isStateFactory<State>(value: State | (() => State)): value is () => State {
  return typeof value === 'function';
}

function createInitialState<State>(initialState: State | (() => State)): State {
  if (isStateFactory(initialState)) return initialState();
  if (typeof initialState === 'object' && initialState !== null) {
    return structuredClone(initialState);
  }

  return initialState;
}

function isStatelessProjection<Event, State>(
  options: StatelessProjectionOptions<Event> | StatefulProjectionOptions<Event, State>,
): options is StatelessProjectionOptions<Event> {
  return options.initialState === undefined;
}

function isReducerResultWithState<State>(
  result: ProjectionReducerResult<State>,
): result is { conversation: ConversationHistory; state: State } {
  return (
    typeof result === 'object' && result !== null && 'conversation' in result && 'state' in result
  );
}

function isMalformedReducerResult<State>(result: ProjectionReducerResult<State>): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'conversation' in result &&
    !('state' in result)
  );
}

/**
 * Returns true when `next` keeps every identity from `previous` in the same
 * position and only appends new identities.
 */
export function isProjectionPrefixExtension(
  previous: readonly ProjectionEventIdentity[],
  next: readonly ProjectionEventIdentity[],
): boolean {
  if (next.length < previous.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Creates an incremental projection over a cumulative append-only event log.
 *
 * Call `apply()` whenever a UI receives the latest event array. The builder
 * compares stable event identities rather than array or event object references,
 * so reactive proxies can hand it fresh objects without forcing a refold.
 */
export function createProjection<Event>(
  options: StatelessProjectionOptions<Event>,
): Projection<Event>;
export function createProjection<Event, State>(
  options: StatefulProjectionOptions<Event, State>,
): Projection<Event>;
export function createProjection<Event, State>(
  options: StatelessProjectionOptions<Event> | StatefulProjectionOptions<Event, State>,
): Projection<Event> {
  return isStatelessProjection(options)
    ? createProjectionWithState(options, undefined)
    : createProjectionWithState(options, options.initialState);
}

function createProjectionWithState<Event, State>(
  options: ProjectionBaseOptions<Event, State>,
  initialState: State | (() => State),
): Projection<Event> {
  const seed = options.seed ?? createConversationHistory();
  const reduce = options.reduce;
  let conversation = seed;
  let state = createInitialState(initialState);
  let eventIdentities: ProjectionEventIdentity[] = [];
  let currentLogKey: ProjectionEventIdentity | undefined;
  let processedCount = 0;

  const reset = () => {
    conversation = seed;
    state = createInitialState(initialState);
    eventIdentities = [];
    currentLogKey = undefined;
    processedCount = 0;
  };

  return {
    apply(events: readonly Event[], applyOptions: ProjectionApplyOptions = {}): void {
      const nextIdentities = events.map((event, index) => options.identify(event, index));
      const sameLogKey = currentLogKey === applyOptions.logKey;
      const isPrefixExtension =
        sameLogKey && isProjectionPrefixExtension(eventIdentities, nextIdentities);
      let nextConversation = isPrefixExtension ? conversation : seed;
      let nextState = isPrefixExtension ? state : createInitialState(initialState);
      const startIndex = isPrefixExtension ? processedCount : 0;

      for (let index = startIndex; index < events.length; index += 1) {
        const event = events[index];
        if (event === undefined) {
          continue;
        }

        const result = reduce({
          conversation: nextConversation,
          event,
          events,
          index,
          state: nextState,
        });

        if (isReducerResultWithState(result)) {
          nextConversation = result.conversation;
          nextState = result.state;
        } else if (isMalformedReducerResult(result)) {
          throw new TypeError('Projection reducer returned a conversation without state.');
        } else {
          nextConversation = result;
        }
      }

      conversation = nextConversation;
      state = nextState;
      eventIdentities = nextIdentities;
      currentLogKey = applyOptions.logKey;
      processedCount = nextIdentities.length;
    },
    reset,
    snapshot(): ConversationHistory {
      return conversation;
    },
    get processedCount() {
      return processedCount;
    },
  };
}
