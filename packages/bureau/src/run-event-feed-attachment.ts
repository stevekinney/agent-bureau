/**
 * Attaches an operative run's event feed to the bureau that launched it.
 *
 * A bureau owns its operatives' events the way it owns their lifecycles: it
 * creates each run's feed, registers it, pumps the run into it, and reaps it
 * when the run goes. Without this a `operative.runs.events` subscription is
 * unreachable for anything a bureau started — the feed is host-pumped by
 * design, and nothing was the host.
 *
 * WHY NOT THE RUN-FRAME STREAM. `createRunFrameForwarder` in `run-envelope.ts`
 * already turns the same `ActiveRun` into `RunFrame`s, and it would be
 * tempting to feed those here instead of keeping a second vocabulary. They
 * are not interchangeable. A `RunFrame` is a transcript: `assistant-chunk`
 * carries model text, `tool-pre` carries tool arguments, and `run-finished`
 * embeds the whole `ConversationHistory` in its report. The run event feed is
 * a lifecycle signal whose payloads are explicit named-field projections
 * chosen so none of that leaks. Publishing frames through an `events:read`
 * subscription would turn watching a run into reading it. They also cover
 * different ground: the forwarder emits nothing for `run.tripwire`,
 * `step.generated`, `tools.executing`/`tools.executed`, or the terminal
 * `run.*` events, and a tripwire survives only as a `finishReason` inside the
 * terminal report.
 *
 * @module run-event-feed-attachment
 */

import {
  createAgentRunEventFeed,
  PUBLISHED_RUN_EVENT_KINDS,
  type ActiveRun,
  type AgentRunEventFeed,
} from '@lostgradient/operative';

/** The mutable half of operative's registry, as this module needs it. */
export type MutableAgentRunEventRegistry = {
  get(runId: string): AgentRunEventFeed | undefined;
  set(runId: string, feed: AgentRunEventFeed): void;
  delete(runId: string): void;
};

export type RunEventFeedAttachmentOptions = {
  /** Retention bound for one run's log, passed through to the feed. */
  maxEvents?: number;
  /** The bureau's composed clock, so a manually-clocked bureau stays deterministic. */
  now?: () => number;
  /** Where a throwing projection is reported. Without one it is swallowed. */
  onError?: (error: unknown, kind: string) => void;
};

/**
 * Creates this run's feed, registers it, and subscribes it to the run.
 *
 * Returns a disposer that detaches the listeners only. The feed stays
 * registered and readable after the run finishes — a client that subscribes
 * on hearing `run.completed` still gets the whole history — until
 * {@link disposeRunEventFeed} reaps it on removal.
 *
 * MUST be called before the run is registered with the store. `store.register`
 * is what drives `run.registered` onto the bureau's own feed, and a client
 * that reacts to that by subscribing to `operative.runs.events` would
 * otherwise race a registry entry that does not exist yet.
 */
export function attachRunEventFeed(
  runId: string,
  activeRun: Pick<ActiveRun, 'addEventListener' | 'removeEventListener'>,
  registry: MutableAgentRunEventRegistry,
  options: RunEventFeedAttachmentOptions = {},
): () => void {
  const feed = createAgentRunEventFeed({
    runId,
    ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  registry.set(runId, feed);

  const disposers: Array<() => void> = [];
  for (const kind of PUBLISHED_RUN_EVENT_KINDS) {
    // The untyped `addEventListener` overload: `feed.publish` takes `unknown`
    // and narrows by projection, so nothing here needs the per-kind event
    // type, and the typed overload will not accept an iterated tuple element
    // without a cast that would claim more than is known.
    const listener = (event: Event): void => {
      // Guarded for the reason bureau guards its own feed pump and its live
      // frame fan-out (AB-96): this listener sits on the run's own emitter,
      // and a throw escaping it would surface inside whichever dispatch the
      // run was making — including its terminal one, which would leave the
      // run wedged as `running`. Recording a run's events must not be able
      // to break the run.
      try {
        feed.publish(event);
      } catch (error) {
        options.onError?.(error, kind);
      }
    };
    activeRun.addEventListener(kind, listener);
    disposers.push(() => activeRun.removeEventListener(kind, listener));
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Reaps a finished run's feed, ending any subscriber still reading it. */
export function disposeRunEventFeed(runId: string, registry: MutableAgentRunEventRegistry): void {
  const feed = registry.get(runId);
  if (feed === undefined) return;
  // Disposal aborts the feed's lifetime signal, which every subscription it
  // handed out is bound to, so a live reader ends rather than going quiet.
  feed.dispose();
  registry.delete(runId);
}
