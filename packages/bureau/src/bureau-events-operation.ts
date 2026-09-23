/**
 * `bureau.events` — a bureau's feed, as a catalog subscription.
 *
 * The third registration into Weft's catalog, after Weft's own operations and
 * `operative.runs.events`, and the reason the catalog was made shared: one
 * dispatch pipeline, one access policy, one AsyncAPI document, whichever
 * runtime a client is watching.
 *
 * @module bureau-events-operation
 */

import {
  createReplayAwareClosableIterable,
  defineOperation,
  type ReplayLiveSubscribeOptions,
} from '@lostgradient/weft';
import { z } from 'zod';

import {
  PUBLISHED_BUREAU_EVENT_KINDS,
  type BureauEventEnvelope,
  type BureauEventFeed,
} from './bureau-event-feed.ts';

/** Matches the bound Weft and Operative apply, for the same reason. */
const MAX_BUREAU_SUBSCRIPTION_REPLAY_EVENTS = 1_000;

const bureauEventKindSchema = z.enum(PUBLISHED_BUREAU_EVENT_KINDS);

const bureauEventsSubscriptionInput = z.object({
  bureauId: z.string().min(1),
  /** One kind, or several. Omitting it delivers every published kind. */
  kinds: z.union([bureauEventKindSchema, z.array(bureauEventKindSchema).min(1)]).optional(),
  fromCursor: z.string().min(1).optional(),
});

const bureauEventsSubscriptionEnvelope = z.object({
  subscriptionId: z.string(),
  cursor: z.string(),
});

/**
 * `payload` is a record rather than a union discriminated on `kind`, matching
 * `operative.runs.events` and Weft's own envelopes. The payloads are already
 * bounded by named-field projections; what a client does not yet get is a
 * static type per kind. Closing that is additive and worth doing once across
 * all three packages rather than differently in each.
 */
export const bureauEventEnvelopeSchema = z.object({
  sequence: z.number(),
  cursor: z.string(),
  bureauId: z.string(),
  kind: z.string(),
  emittedAtMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
});

export type BureauEventsSubscriptionInput = z.infer<typeof bureauEventsSubscriptionInput>;

/** Resolves a bureau id to its feed. Supplied by whichever host owns bureau lifetimes. */
export type BureauEventRegistry = {
  get(bureauId: string): BureauEventFeed | undefined;
};

export function createBureauEventRegistry(): BureauEventRegistry & {
  set(bureauId: string, feed: BureauEventFeed): void;
  delete(bureauId: string): void;
} {
  const feeds = new Map<string, BureauEventFeed>();
  return {
    get: (bureauId) => feeds.get(bureauId),
    set: (bureauId, feed) => {
      feeds.set(bureauId, feed);
    },
    delete: (bureauId) => {
      feeds.delete(bureauId);
    },
  };
}

/** The shape a host passes as the operation's `engine` value. */
export type BureauEventsOperationEngine = { bureauFeeds: BureauEventRegistry };

export const bureauEventsSubscriptionOperation = defineOperation({
  name: 'bureau.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Subscribe to a bureau’s lifecycle events with replay-from-cursor',
  description:
    'Replays the bureau’s events from `fromCursor` (or the beginning) and then follows live. Covers registration, recovery, disposal, and review lifecycle; supervisor task and synthesis events are not published. Requires `events:read`.',
  destructive: false,
  tags: ['Events'],
  inputSchema: bureauEventsSubscriptionInput,
  outputSchema: bureauEventsSubscriptionEnvelope,
  producibleFaults: ['InvalidParams', 'NotFound'],
  eventSchema: bureauEventEnvelopeSchema,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
  discoverable: true,
  transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }) => {
    const registry = (engine as BureauEventsOperationEngine).bureauFeeds;
    const bureauFeed = registry.get(input.bureauId);
    if (bureauFeed === undefined) {
      throw new Error(`Unknown bureau "${input.bureauId}"`);
    }

    // Only the session's own signal: the feed binds its own lifetime into
    // every subscription, so disposing the bureau ends this one too.
    const controller = new AbortController();
    // Normalized here rather than by a schema `.transform()`, so `invoke`
    // behaves identically whether it is reached through the catalog pipeline
    // or called directly.
    const kinds =
      input.kinds === undefined
        ? undefined
        : new Set<string>(Array.isArray(input.kinds) ? input.kinds : [input.kinds]);
    const subscribeOptions: ReplayLiveSubscribeOptions<BureauEventEnvelope> = {
      ...(input.fromCursor === undefined ? {} : { fromCursor: input.fromCursor }),
      signal: controller.signal,
      replayLimit: MAX_BUREAU_SUBSCRIPTION_REPLAY_EVENTS,
      // No `countReplayEnvelope`: the feed filters before counting, so the
      // cap already measures matching events.
      filterEnvelope: (envelope) => kinds === undefined || kinds.has(envelope.kind),
    };
    const iterable = createReplayAwareClosableIterable<BureauEventEnvelope>(
      (onReplayComplete) => bureauFeed.feed.subscribe({ ...subscribeOptions, onReplayComplete }),
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
