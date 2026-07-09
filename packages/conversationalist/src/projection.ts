import { createConversationHistory } from './conversation/index';
import type { ConversationHistory } from './types';

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

export type ProjectionOptions<Event, State = undefined> = {
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
  /**
   * Optional caller state owned by the projection builder. Use this for active
   * streaming message ids, streaming accumulators, or other reducer-local cursors
   * that must survive across prefix-extension calls and reset on divergence.
   */
  initialState?: State | (() => State);
};

export type Projection<Event> = {
  /**
   * Applies a cumulative append-only event log. Prefix extensions process only
   * the new tail; divergent logs reset to the seed and refold from the start.
   */
  apply(events: readonly Event[]): void;
  /** Returns the current immutable conversation projection. */
  snapshot(): ConversationHistory;
  /** Number of events from the latest accepted log that have been processed. */
  readonly processedCount: number;
};

function createInitialState<State>(initialState: State | (() => State) | undefined): State {
  return typeof initialState === 'function'
    ? (initialState as () => State)()
    : (initialState as State);
}

function isReducerResultWithState<State>(
  result: ProjectionReducerResult<State>,
): result is { conversation: ConversationHistory; state: State } {
  return typeof result === 'object' && result !== null && 'conversation' in result;
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
export function createProjection<Event, State = undefined>(
  options: ProjectionOptions<Event, State>,
): Projection<Event> {
  const seed = options.seed ?? createConversationHistory();
  let conversation = seed;
  let state = createInitialState(options.initialState);
  let eventIdentities: ProjectionEventIdentity[] = [];
  let processedCount = 0;

  return {
    apply(events: readonly Event[]): void {
      const nextIdentities = events.map((event, index) => options.identify(event, index));
      const isPrefixExtension = isProjectionPrefixExtension(eventIdentities, nextIdentities);
      let nextConversation = isPrefixExtension ? conversation : seed;
      let nextState = isPrefixExtension ? state : createInitialState(options.initialState);
      const startIndex = isPrefixExtension ? processedCount : 0;

      for (let index = startIndex; index < events.length; index += 1) {
        const event = events[index];
        if (event === undefined) {
          continue;
        }

        const result = options.reduce({
          conversation: nextConversation,
          event,
          events,
          index,
          state: nextState,
        });

        if (isReducerResultWithState(result)) {
          nextConversation = result.conversation;
          nextState = result.state;
        } else {
          nextConversation = result;
        }
      }

      conversation = nextConversation;
      state = nextState;
      eventIdentities = nextIdentities;
      processedCount = nextIdentities.length;
    },
    snapshot(): ConversationHistory {
      return conversation;
    },
    get processedCount() {
      return processedCount;
    },
  };
}
