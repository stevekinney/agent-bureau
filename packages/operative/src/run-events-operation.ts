/**
 * `operative.runs.events` — an agent run's feed, as a catalog subscription.
 *
 * Declared with Weft's `defineOperation` rather than a bespoke endpoint, so a
 * client subscribing to a run speaks the same JSON-RPC dialect, obeys the same
 * access policy, and appears in the same AsyncAPI document as one subscribing
 * to a workflow. That consistency is the whole reason this package registers
 * into Weft's catalog instead of standing up its own.
 *
 * @module run-events-operation
 */

import {
  createReplayAwareClosableIterable,
  defineOperation,
  type ReplayLiveSubscribeOptions,
} from '@lostgradient/weft';
import { z } from 'zod';

import {
  PUBLISHED_RUN_EVENT_KINDS,
  type AgentRunEventEnvelope,
  type AgentRunEventFeed,
} from './run-event-feed.ts';

/**
 * How many replayed envelopes a subscription will deliver before refusing.
 *
 * A run that has been executing for a while can have produced far more events
 * than a late joiner wants delivered in one burst. Weft's workflow
 * subscription applies the same bound for the same reason; exceeding it is a
 * caller error answered with a more recent cursor, not a truncated stream
 * that silently loses the middle.
 */
const MAX_RUN_SUBSCRIPTION_REPLAY_EVENTS = 1_000;

const runEventKindSchema = z.enum(PUBLISHED_RUN_EVENT_KINDS);

/**
 * `kinds` accepts one name or several, and omitting it delivers everything.
 *
 * A SET rather than a single value, because the alternatives are both bad: a
 * client wanting three of ten kinds either opens three subscriptions and
 * tracks three cursors for what is logically one stream, or takes the whole
 * feed and discards most of it across a socket. The union accepts a bare
 * string too, so narrowing to one kind stays the simple case.
 */
const runEventsSubscriptionInput = z.object({
  runId: z.string().min(1),
  kinds: z.union([runEventKindSchema, z.array(runEventKindSchema).min(1)]).optional(),
  fromCursor: z.string().min(1).optional(),
});

const runEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

/**
 * The event envelope as the wire carries it.
 *
 * `payload` is `z.record(z.string(), z.unknown())` rather than a discriminated
 * union over `kind`, and that is a deliberate first step rather than the end
 * state. The payloads are produced by named-field projections in
 * `run-event-feed.ts`, so what crosses is already bounded and redacted; what
 * this schema does not yet give a client is a static type per `kind`. Turning
 * it into a discriminated union is additive — every payload already validates
 * against this shape — and is worth doing once the projected set stops
 * growing.
 */
export const runEventEnvelopeSchema = z.object({
  sequence: z.number(),
  cursor: z.string(),
  runId: z.string(),
  kind: z.string(),
  emittedAtMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
});

export type RunEventsSubscriptionInput = z.infer<typeof runEventsSubscriptionInput>;

/** Resolves a run id to its feed. Supplied by whichever host owns run lifetimes. */
export type AgentRunEventRegistry = {
  get(runId: string): AgentRunEventFeed | undefined;
};

/**
 * A registry backed by a plain map, for a host with no opinion of its own.
 *
 * Deliberately not a singleton: a gateway process may serve several tenants,
 * and a module-scoped map would make one tenant's run ids visible to another
 * by guessing.
 */
export function createAgentRunEventRegistry(): AgentRunEventRegistry & {
  set(runId: string, feed: AgentRunEventFeed): void;
  delete(runId: string): void;
  /**
   * The registered run ids, snapshotted.
   *
   * On the mutable half only: the operation needs `get` and nothing else,
   * while a host shutting down needs to reap whatever it still holds. A
   * snapshot rather than a live view, so a caller can dispose as it iterates.
   */
  runIds(): readonly string[];
} {
  const feeds = new Map<string, AgentRunEventFeed>();
  return {
    get: (runId) => feeds.get(runId),
    set: (runId, feed) => {
      feeds.set(runId, feed);
    },
    delete: (runId) => {
      feeds.delete(runId);
    },
    runIds: () => Array.from(feeds.keys()),
  };
}

/** The shape a host passes as the operation's `engine` value. */
export type RunEventsOperationEngine = { runFeeds: AgentRunEventRegistry };

export const runEventsSubscriptionOperation = defineOperation({
  name: 'operative.runs.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Subscribe to an agent run’s events with replay-from-cursor',
  description:
    'Replays the run’s events from `fromCursor` (or the beginning) and then follows live. Requires `events:read`. The grant is checked when the subscription starts and remains active until unsubscribe, socket close, or feed termination.',
  destructive: false,
  tags: ['Events'],
  inputSchema: runEventsSubscriptionInput,
  outputSchema: runEventsSubscriptionEnvelope,
  producibleFaults: ['InvalidParams', 'NotFound'],
  eventSchema: runEventEnvelopeSchema,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  discoverable: true,
  // WebSocket only. A run's event feed is long-lived and resumable, which a
  // single HTTP response cannot express; a caller wanting a bounded window
  // should read it through a unary operation instead.
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => {
    // The subscription session passes `{ runFeeds }` as this operation's
    // engine value, the same way Weft's workflow subscription receives
    // `{ feed }`.
    const registry = (engine as RunEventsOperationEngine).runFeeds;
    const runFeed = registry.get(input.runId);
    if (runFeed === undefined) {
      // An unknown run is a caller error, not a transport failure: the run may
      // have completed and been reaped between listing it and subscribing.
      throw new Error(`Unknown run "${input.runId}"`);
    }

    // Only the session's own signal is needed: `createAgentRunEventFeed`
    // binds the feed's lifetime into every subscription it hands out, so
    // reaping the run ends this subscription too.
    const controller = new AbortController();
    // Normalized HERE rather than by a schema `.transform()`, so `invoke`
    // behaves identically whether it is reached through the catalog pipeline
    // or called directly. A transform would make the parsed and declared
    // input types differ, which is the kind of difference that only shows up
    // in whichever of the two paths has no test.
    const kinds =
      input.kinds === undefined
        ? undefined
        : new Set<string>(Array.isArray(input.kinds) ? input.kinds : [input.kinds]);
    const matches = (envelope: AgentRunEventEnvelope): boolean =>
      kinds === undefined || kinds.has(envelope.kind);
    const subscribeOptions: ReplayLiveSubscribeOptions<AgentRunEventEnvelope> = {
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      signal: controller.signal,
      replayLimit: MAX_RUN_SUBSCRIPTION_REPLAY_EVENTS,
      // `countReplayEnvelope` is deliberately NOT passed. The feed applies
      // `filterEnvelope` first and only counts what survives it
      // (`replay-live-feed-internals.ts`), so the replay cap already measures
      // matching events — supplying a counter equal to the filter would just
      // run the predicate twice per envelope.
      filterEnvelope: matches,
    };
    const iterable = createReplayAwareClosableIterable<AgentRunEventEnvelope>(
      (onReplayComplete) => runFeed.feed.subscribe({ ...subscribeOptions, onReplayComplete }),
      { close: () => controller.abort() },
    );

    return {
      envelope: {
        subscriptionId: `sub_${crypto.randomUUID()}`,
        cursor: input.fromCursor ?? '-1',
      },
      iterable,
      close: () => iterable.close(),
    };
  },
});
