/**
 * A bureau's events, as a replay-plus-live feed.
 *
 * The same boundary `@lostgradient/operative`'s `run-event-feed.ts` draws, for the
 * same reasons, on the same Weft primitive — so a client watching a bureau
 * gets the cursors, replay, and resume semantics it already gets watching a
 * run or a workflow.
 *
 * ONE FEED PER BUREAU, not per run. Bureau's events are instance-scoped:
 * registration, recovery, disposal, and review lifecycle describe the
 * supervisor rather than any single run, so the feed is shaped like Weft's
 * fleet feed rather than its per-workflow one. A subscriber narrows with the
 * operation's `kinds` filter.
 *
 * @module bureau-event-feed
 */

import {
  bindFeedLifetime,
  createInMemoryReplayLiveBackend,
  createReplayLiveFeed,
  encodeCursor,
  type InMemoryReplayLiveBackend,
  type ReplayLiveFeed,
  type SequencedEventEnvelope,
} from '@lostgradient/weft';

import {
  ActionEvent,
  BureauDisposedEvent,
  RecoveryAttemptedEvent,
  RecoveryLeaseReleasedEvent,
  RecoveryRejectedEvent,
  ReviewApprovedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
  RunRegisteredEvent,
  RunRemovedEvent,
} from './events.ts';

export type BureauEventEnvelope = SequencedEventEnvelope & {
  readonly bureauId: string;
  readonly kind: string;
  readonly emittedAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

type BureauEventProjection = {
  readonly kind: string;
  readonly tryProject: (event: unknown) => Readonly<Record<string, unknown>> | undefined;
};

function projection<TEvent>(
  kind: string,
  matches: (event: unknown) => event is TEvent,
  project: (event: TEvent) => Readonly<Record<string, unknown>>,
): BureauEventProjection {
  return { kind, tryProject: (event) => (matches(event) ? project(event) : undefined) };
}

const isInstance =
  <TEvent>(constructor: abstract new (...args: never[]) => TEvent) =>
  (event: unknown): event is TEvent =>
    event instanceof constructor;

/**
 * A settled review, projected identically whichever verb settled it.
 *
 * `reviewKind` rather than `kind`, deliberately. The review classes carry
 * their own `kind` field (which sort of review it was), and the envelope
 * already uses `kind` for the event type. Two different meanings under one
 * name in nested objects is a reliable way to read the wrong one.
 */
function projectReview(event: {
  reviewId: string;
  runId: string;
  principal: string;
  kind: string;
}): Readonly<Record<string, unknown>> {
  return {
    reviewId: event.reviewId,
    runId: event.runId,
    principal: event.principal,
    reviewKind: event.kind,
  };
}

/**
 * The events this feed publishes, and the only ones it publishes.
 *
 * Every field is named explicitly, for the reason `run-event-feed.ts`
 * documents at length: a generic projection ships whatever an event happens
 * to carry.
 *
 * THE SUPERVISOR EVENTS ARE ABSENT ON PURPOSE. `task.routed`,
 * `task.completed`, `task.failed`, `synthesis.started`, and
 * `synthesis.completed` carry the task text, a whole `RunResult`, a raw
 * `unknown` error, and the synthesized output — the model's inputs and
 * outputs, not a supervisor's lifecycle. A subscriber authorized to watch a
 * bureau is not thereby authorized to read what it was asked to do. Adding
 * them is a deliberate decision with an access-policy question attached, not
 * an oversight.
 */
const PROJECTIONS: readonly BureauEventProjection[] = [
  projection(ActionEvent.type, isInstance(ActionEvent), (event) => ({
    // `detail` is `unknown` and caller-supplied, so the log's shape crosses
    // but its contents do not.
    sequence: event.action.sequence,
    runId: event.action.runId,
    actionType: event.action.type,
    timestamp: event.action.timestamp,
  })),
  projection(RunRegisteredEvent.type, isInstance(RunRegisteredEvent), (event) => ({
    runId: event.runId,
  })),
  projection(RunRemovedEvent.type, isInstance(RunRemovedEvent), (event) => ({
    runId: event.runId,
  })),
  projection(BureauDisposedEvent.type, isInstance(BureauDisposedEvent), () => ({})),
  projection(RecoveryAttemptedEvent.type, isInstance(RecoveryAttemptedEvent), (event) => ({
    runId: event.runId,
    verdict: event.verdict,
  })),
  projection(RecoveryRejectedEvent.type, isInstance(RecoveryRejectedEvent), (event) => ({
    runId: event.runId,
    reason: event.reason,
  })),
  projection(RecoveryLeaseReleasedEvent.type, isInstance(RecoveryLeaseReleasedEvent), (event) => ({
    // The lease evidence itself is Weft's projection of engine health and is
    // not reshaped here; a subscriber that needs it reads the run.
    runId: event.runId,
  })),
  projection(ReviewApprovedEvent.type, isInstance(ReviewApprovedEvent), projectReview),
  projection(ReviewDeniedEvent.type, isInstance(ReviewDeniedEvent), projectReview),
  projection(ReviewRejectedEvent.type, isInstance(ReviewRejectedEvent), projectReview),
  projection(ReviewExpiredEvent.type, isInstance(ReviewExpiredEvent), projectReview),
  projection(ReviewRevokedEvent.type, isInstance(ReviewRevokedEvent), projectReview),
  projection(ReviewCanceledEvent.type, isInstance(ReviewCanceledEvent), projectReview),
  projection(ReviewSupersededEvent.type, isInstance(ReviewSupersededEvent), projectReview),
];

/**
 * Every event kind this feed publishes, as a literal tuple.
 *
 * Spelled out so a subscriber filtering by kind gets literal types rather
 * than `string`; `bureau-event-feed.test.ts` asserts it agrees with the
 * registry above.
 */
export const PUBLISHED_BUREAU_EVENT_KINDS = [
  ActionEvent.type,
  RunRegisteredEvent.type,
  RunRemovedEvent.type,
  BureauDisposedEvent.type,
  RecoveryAttemptedEvent.type,
  RecoveryRejectedEvent.type,
  RecoveryLeaseReleasedEvent.type,
  ReviewApprovedEvent.type,
  ReviewDeniedEvent.type,
  ReviewRejectedEvent.type,
  ReviewExpiredEvent.type,
  ReviewRevokedEvent.type,
  ReviewCanceledEvent.type,
  ReviewSupersededEvent.type,
] as const;

export type PublishedBureauEventKind = (typeof PUBLISHED_BUREAU_EVENT_KINDS)[number];

/** Every event kind this feed knows how to publish, as declared by the registry. */
export const publishedBureauEventKinds: readonly string[] = PROJECTIONS.map((entry) => entry.kind);

/** Projects one dispatched event, or `undefined` when it has no projection. */
export function projectBureauEvent(
  event: unknown,
): { kind: string; payload: Readonly<Record<string, unknown>> } | undefined {
  for (const entry of PROJECTIONS) {
    const payload = entry.tryProject(event);
    if (payload !== undefined) return { kind: entry.kind, payload };
  }
  return undefined;
}

export type BureauEventFeed = {
  readonly feed: ReplayLiveFeed<BureauEventEnvelope>;
  /**
   * Aborts when the feed is disposed, so a live subscription ends instead of
   * going quiet — disposing a feed otherwise unhooks its subscribers without
   * waking them. Every subscription `feed` hands out is already bound to
   * this signal by Weft's `bindFeedLifetime`; a caller needs it only to ask
   * whether the feed is still live.
   */
  readonly signal: AbortSignal;
  publish(event: unknown): BureauEventEnvelope | undefined;
  dispose(): void;
};

export type BureauEventFeedOptions = {
  bureauId: string;
  maxEvents?: number;
  now?: () => number;
};

export function createBureauEventFeed(options: BureauEventFeedOptions): BureauEventFeed {
  const now = options.now ?? (() => Date.now());
  const backend: InMemoryReplayLiveBackend<BureauEventEnvelope> =
    createInMemoryReplayLiveBackend<BureauEventEnvelope>(
      options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents },
    );
  const lifetime = new AbortController();
  const feed = bindFeedLifetime(
    createReplayLiveFeed<BureauEventEnvelope>(backend),
    lifetime.signal,
  );
  let sequence = 0;

  return {
    feed,
    signal: lifetime.signal,
    publish(event) {
      const projected = projectBureauEvent(event);
      if (projected === undefined) return undefined;
      const envelope: BureauEventEnvelope = {
        sequence,
        cursor: encodeCursor(sequence),
        bureauId: options.bureauId,
        kind: projected.kind,
        emittedAtMs: now(),
        payload: projected.payload,
      };
      sequence += 1;
      backend.append(envelope);
      return envelope;
    },
    dispose() {
      // Before the backend, so a subscriber observes the abort rather than a
      // silently emptied log.
      lifetime.abort();
      feed.dispose();
      backend.dispose();
    },
  };
}
