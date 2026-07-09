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

function createInitialState<State>(initialState: State | (() => State) | undefined): State {
  if (typeof initialState === 'function') {
    return (initialState as () => State)();
  }

  const state = initialState as State;

  if (typeof state === 'object' && state !== null) {
    return structuredClone(state);
  }

  return state;
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
  const seed = options.seed ?? createConversationHistory();
  const reduce = options.reduce as ProjectionReducer<Event, State>;
  let conversation = seed;
  let state = createInitialState(options.initialState);
  let eventIdentities: ProjectionEventIdentity[] = [];
  let currentLogKey: ProjectionEventIdentity | undefined;
  let processedCount = 0;

  const reset = () => {
    conversation = seed;
    state = createInitialState(options.initialState);
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
      let nextState = isPrefixExtension ? state : createInitialState(options.initialState);
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
