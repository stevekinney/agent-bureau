/**
 * An agent run's events, as a replay-plus-live feed.
 *
 * Operative dispatches its events as `Event` subclasses on an in-process
 * target. That is the right shape for a listener in the same process and the
 * wrong one for a client across a socket: the classes carry live object
 * references, and one of them carries an `AgentRunError` whose `cause` can be
 * a provider's HTTP response with authorization headers on it.
 *
 * This module is the boundary between the two. It borrows Weft's
 * `createReplayLiveFeed` rather than growing a parallel one — Weft already
 * instantiates it for workflow and fleet events, and `@lostgradient/operative`
 * already depends on Weft — so a subscriber gets the same cursors, the same
 * replay-then-live join, and the same resume semantics whichever runtime it
 * is watching.
 *
 * THE FEED IS IN-MEMORY TODAY. `createInMemoryReplayLiveBackend` bounds the
 * log and loses it on restart. A durable backend is a replacement for that
 * one argument and changes nothing here or above.
 *
 * @module run-event-feed
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

import { AgentRunError } from './errors.ts';
import {
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
  RunStartedEvent,
  RunTripwireEvent,
  StepCompletedEvent,
  StepGeneratedEvent,
  StepStartedEvent,
  ToolsExecutedEvent,
  ToolsExecutingEvent,
} from './events.ts';

/**
 * One projected event on the wire.
 *
 * `kind` is the event's own `type` string, which every Operative event
 * declares as a `static readonly type`, so the discriminator is the class's
 * rather than one invented here.
 */
export type AgentRunEventEnvelope = SequencedEventEnvelope & {
  readonly runId: string;
  readonly kind: string;
  readonly emittedAtMs: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

/**
 * How one event class becomes one payload.
 *
 * EVERY FIELD IS NAMED EXPLICITLY, and that is the security property, not a
 * style choice. A generic projection over own-enumerable properties would
 * serialize whatever an event happens to carry — including
 * `RunErrorEvent.error.cause`, which for a provider failure can be the raw
 * HTTP response, credential headers included. Listing fields means a new
 * field on an event class reaches no client until somebody adds it here.
 */
type RunEventProjection = {
  readonly kind: string;
  /** Projects the event, or returns `undefined` when this entry does not match it. */
  readonly tryProject: (event: unknown) => Readonly<Record<string, unknown>> | undefined;
};

/**
 * Erases the event type at construction, where it is still known.
 *
 * A registry of `RunEventProjection<TEvent>` cannot be widened to a common
 * element type: `TEvent` sits in an output position in `matches` and an input
 * position in `project`, so the type is invariant and every attempt to hold
 * the entries in one array needs a cast. Closing over the narrowing here
 * means the array is homogeneous and no cast is required anywhere.
 */
function projection<TEvent>(
  kind: string,
  matches: (event: unknown) => event is TEvent,
  project: (event: TEvent) => Readonly<Record<string, unknown>>,
): RunEventProjection {
  return {
    kind,
    tryProject: (event) => (matches(event) ? project(event) : undefined),
  };
}

const isInstance =
  <TEvent>(constructor: abstract new (...args: never[]) => TEvent) =>
  (event: unknown): event is TEvent =>
    event instanceof constructor;

/**
 * An error, reduced to what a client can act on.
 *
 * `cause` and `stack` are deliberately absent. `@lostgradient/telephone` applies
 * the same rule to the chat wire for the same reason, and the two are
 * independent on purpose: a producer that forgot one should not inherit the
 * other's omission by accident.
 */
function projectError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof AgentRunError) {
    return { name: error.name, kind: error.kind, code: error.code, message: error.message };
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : 'Unknown error',
  };
}

/**
 * Tool calls are projected to identity only — no `arguments`.
 *
 * This feed is for observing a run's progress, not for reconstructing its
 * content; a chat client reads the turn through `@lostgradient/telephone`'s
 * stream, which has its own contract. Arguments are unbounded and
 * caller-supplied, so they stay off a feed whose subscribers are authorized
 * to watch a run rather than to read its inputs. Widening this later is a
 * deliberate decision with an access-policy question attached.
 */
function projectToolCalls(
  toolCalls: readonly { id: string; name: string }[],
): readonly Readonly<Record<string, unknown>>[] {
  return toolCalls.map((toolCall) => ({ id: toolCall.id, name: toolCall.name }));
}

function projectResults(
  results: readonly { callId: string; outcome: string }[],
): readonly Readonly<Record<string, unknown>>[] {
  return results.map((result) => ({ callId: result.callId, outcome: result.outcome }));
}

function projectUsage(
  usage: { prompt: number; completion: number; total: number } | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (usage === undefined) return undefined;
  return { prompt: usage.prompt, completion: usage.completion, total: usage.total };
}

function withUsage(
  base: Readonly<Record<string, unknown>>,
  usage: { prompt: number; completion: number; total: number } | undefined,
): Readonly<Record<string, unknown>> {
  const projected = projectUsage(usage);
  return projected === undefined ? base : { ...base, usage: projected };
}

/**
 * The events this feed publishes, and the only ones it publishes.
 *
 * Operative exports far more event classes than appear here. An event with no
 * entry is DROPPED rather than forwarded with an opaque payload, which is the
 * safe default in both directions: nothing reaches a client that nobody has
 * looked at, and adding coverage is a visible, reviewable change.
 * `run-event-feed.test.ts` reports the gap so the omission stays deliberate
 * rather than forgotten.
 */
const PROJECTIONS: readonly RunEventProjection[] = [
  projection(RunStartedEvent.type, isInstance(RunStartedEvent), () => ({})),
  projection(StepStartedEvent.type, isInstance(StepStartedEvent), (event) => ({
    step: event.step,
  })),
  projection(StepGeneratedEvent.type, isInstance(StepGeneratedEvent), (event) =>
    withUsage({ step: event.step, toolCalls: projectToolCalls(event.toolCalls) }, event.usage),
  ),
  projection(ToolsExecutingEvent.type, isInstance(ToolsExecutingEvent), (event) => ({
    step: event.step,
    toolCalls: projectToolCalls(event.toolCalls),
  })),
  projection(ToolsExecutedEvent.type, isInstance(ToolsExecutedEvent), (event) => ({
    step: event.step,
    toolCalls: projectToolCalls(event.toolCalls),
    results: projectResults(event.results),
  })),
  projection(StepCompletedEvent.type, isInstance(StepCompletedEvent), (event) =>
    withUsage(
      {
        step: event.step,
        final: event.final,
        toolCalls: projectToolCalls(event.toolCalls),
        results: projectResults(event.results),
      },
      event.usage,
    ),
  ),
  projection(RunCompletedEvent.type, isInstance(RunCompletedEvent), () => ({})),
  projection(RunTripwireEvent.type, isInstance(RunTripwireEvent), (event) => ({
    step: event.step,
    guardrailName: event.guardrailName,
    category: event.category,
    phase: event.phase,
    confidence: event.confidence,
    // `detail` is guardrail-authored prose about the offending content and can
    // quote it, so it stays off the feed: a subscriber authorized to watch a
    // run is not thereby authorized to read what tripped a guardrail.
  })),
  projection(RunErrorEvent.type, isInstance(RunErrorEvent), (event) => ({
    step: event.step,
    error: projectError(event.error),
  })),
  projection(RunAbortedEvent.type, isInstance(RunAbortedEvent), (event) =>
    withUsage(
      {
        step: event.step,
        error: projectError(event.error),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      },
      event.usage,
    ),
  ),
];

/**
 * Every event kind this feed publishes, as a literal tuple.
 *
 * SPELLED OUT rather than derived from `PROJECTIONS`, because a `map` over
 * that array widens to `string[]` and a subscriber filtering by kind would
 * then get no completion and no compile-time check on the names it passes.
 * The duplication is deliberate and guarded: `run-event-feed.test.ts` asserts
 * this tuple and the registry agree, so adding a projection without adding it
 * here fails rather than silently becoming unfilterable.
 */
export const PUBLISHED_RUN_EVENT_KINDS = [
  RunStartedEvent.type,
  StepStartedEvent.type,
  StepGeneratedEvent.type,
  ToolsExecutingEvent.type,
  ToolsExecutedEvent.type,
  StepCompletedEvent.type,
  RunCompletedEvent.type,
  RunTripwireEvent.type,
  RunErrorEvent.type,
  RunAbortedEvent.type,
] as const;

/** One of the event kinds this feed publishes. */
export type PublishedRunEventKind = (typeof PUBLISHED_RUN_EVENT_KINDS)[number];

/** Every event kind this feed knows how to publish, as declared by the registry. */
export const publishedRunEventKinds: readonly string[] = PROJECTIONS.map((entry) => entry.kind);

/**
 * Projects one dispatched event, or `undefined` when it has no projection.
 *
 * Exported so a coverage test can assert which kinds are published without
 * standing up a feed.
 */
export function projectRunEvent(
  event: unknown,
): { kind: string; payload: Readonly<Record<string, unknown>> } | undefined {
  for (const entry of PROJECTIONS) {
    const payload = entry.tryProject(event);
    if (payload !== undefined) return { kind: entry.kind, payload };
  }
  return undefined;
}

export type AgentRunEventFeed = {
  readonly feed: ReplayLiveFeed<AgentRunEventEnvelope>;
  /**
   * Aborts when the feed is disposed.
   *
   * The feed primitive ends a live subscriber on its subscription `signal`
   * and on nothing else — `drainLive` loops until the signal aborts, and
   * disposing the backend only unhooks the listener, leaving the generator
   * parked on a waker that can never fire again. A host that reaps a
   * finished run therefore has to tell existing subscribers, not just stop
   * feeding them. Every subscription `feed` hands out is already bound to
   * this signal (Weft's `bindFeedLifetime`), so a caller needs it only to
   * ask whether the feed is still live.
   */
  readonly signal: AbortSignal;
  /**
   * Projects and records one dispatched event. Returns the envelope, or
   * `undefined` when the event has no projection and was dropped.
   */
  publish(event: unknown): AgentRunEventEnvelope | undefined;
  dispose(): void;
};

export type AgentRunEventFeedOptions = {
  runId: string;
  /** Retention bound for the in-memory log. */
  maxEvents?: number;
  /** Overridable so a test can pin timestamps. */
  now?: () => number;
};

/**
 * Builds a feed for one run.
 *
 * The caller owns the pump: `for await (const event of run) feed.publish(event)`
 * is the whole integration, and it stays the caller's because a host that also
 * wants the events for something else should not have to subscribe twice.
 */
export function createAgentRunEventFeed(options: AgentRunEventFeedOptions): AgentRunEventFeed {
  const now = options.now ?? (() => Date.now());
  const backend: InMemoryReplayLiveBackend<AgentRunEventEnvelope> =
    createInMemoryReplayLiveBackend<AgentRunEventEnvelope>(
      options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents },
    );
  const lifetime = new AbortController();
  const feed = bindFeedLifetime(
    createReplayLiveFeed<AgentRunEventEnvelope>(backend),
    lifetime.signal,
  );
  let sequence = 0;

  return {
    feed,
    signal: lifetime.signal,
    publish(event) {
      const projected = projectRunEvent(event);
      if (projected === undefined) return undefined;
      const envelope: AgentRunEventEnvelope = {
        sequence,
        cursor: encodeCursor(sequence),
        runId: options.runId,
        kind: projected.kind,
        emittedAtMs: now(),
        payload: projected.payload,
      };
      sequence += 1;
      backend.append(envelope);
      return envelope;
    },
    dispose() {
      // Aborted BEFORE the backend is torn down, so a subscriber's generator
      // observes the abort rather than a silently emptied log.
      lifetime.abort();
      feed.dispose();
      backend.dispose();
    },
  };
}
