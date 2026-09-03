import type {
  LivenessAssessment,
  LivenessEvidenceEntry,
  LivenessProgressState,
  LivenessReachability,
  LivenessSnapshot,
  StallPolicy,
  StallWatchdog,
  StallWatchdogClock,
} from '@lostgradient/operative/liveness';
import {
  createStallWatchdog,
  GATEWAY_CONNECTION_POLICY,
  LIVENESS_POLICY_VERSION,
} from '@lostgradient/operative/liveness';

import type { ServerFrame } from './types';

export const ALL_RUNS_SUBSCRIPTION = '*';

/**
 * Default heartbeat interval in milliseconds.
 *
 * Must be shorter than the reverse-proxy and server idle timeout so the
 * connection is never silently killed during long silences (e.g. a parked
 * human-in-the-loop workflow or a slow tool call).
 *
 * Bun.serve defaults `idleTimeout` to 10 s; common reverse proxies (nginx,
 * AWS ALB) default to 60 s. We pick 8 s — safely under both — and expose
 * `heartbeatIntervalMs` so callers can tune it.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 8_000;

/**
 * Per-run replay buffer cap (AB-15). Bounded so a long-running or
 * high-frequency run cannot grow this in-memory buffer without limit.
 *
 * This buffer lives in process memory only — it does not survive a process
 * restart or redeploy. A reconnect that outlives the process (or whose
 * requested cursor predates the buffer's floor, once trimmed) can only
 * resume from the oldest frame still held; anything older than that is
 * unrecoverable from the live-frame layer and the client should fall back
 * to `GET /api/v1/runs/:id` for the durable record.
 */
const RUN_FRAME_BUFFER_LIMIT = 2_000;

/**
 * A `gateway-connection` liveness snapshot, per AB-219's acceptance
 * criteria (AB-88's AC4 shape, narrowed to `kind: 'gateway-connection'`).
 */
export type GatewayConnectionSnapshot = LivenessSnapshot & { kind: 'gateway-connection' };

/**
 * The timer seam {@link LiveFrameBroker} uses for its heartbeat interval and
 * per-connection watchdog. Extends obs-01's {@link StallWatchdogClock} with
 * `setInterval`/`clearInterval` — the existing SSE heartbeat mechanism —
 * and `nowISO` for each connection's `startedAt` timestamp, so a test can
 * inject one fake clock that drives all of it, per AB-219's testing plan
 * (no real timers, no real sleeps). Defaults to the real globals so no
 * existing caller (`new LiveFrameBroker()`) is affected. AB-303:
 * `createGateway` builds this seam from its resolved `RuntimeServices`
 * instance — `now` from `RuntimeServices.monotonic.now` (this is the
 * cadence clock `StallWatchdogClock` expects, not wall time), `nowISO`
 * from `RuntimeServices.clock.nowISO`, and the four timer members from
 * `RuntimeServices.timers` — so the watchdog only advances when that same
 * instance's clock or timers do.
 */
export interface LiveFrameBrokerClock extends StallWatchdogClock {
  nowISO(): string;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realClock: LiveFrameBrokerClock = {
  now: () => performance.now(),
  nowISO: () => new Date().toISOString(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type LiveFrameBrokerOptions = {
  clock?: LiveFrameBrokerClock;
};

/**
 * Builds this connection's own `StallPolicy` row, derived from obs-01's
 * `GATEWAY_CONNECTION_POLICY` (AB-214's `policies.ts`) but with `cadenceMs`
 * overridden to the connection's own resolved `heartbeatIntervalMs` — never
 * the fixed `8000` the base row declares — per AB-219's acceptance
 * criteria. `graceMs` and `jitterMs` are recomputed against the real
 * cadence for the same reason (a fixed `graceMs: 4000`/`jitterMs: 800`,
 * sized for the 8 s default, would misclassify a connection opened with a
 * deliberately longer or shorter interval). `jitterMs` uses AB-214's own
 * formula — 10 percent of `cadenceMs`, floored at 50 ms. No new
 * `StallPolicy` row is added to `policies.ts`; this is a per-connection
 * override of the existing row, computed locally.
 */
function gatewayConnectionPolicy(cadenceMs: number): StallPolicy {
  return {
    ...GATEWAY_CONNECTION_POLICY,
    cadenceMs,
    graceMs: cadenceMs / 2,
    jitterMs: Math.max(50, Math.round(cadenceMs * 0.1)),
  };
}

/**
 * Whether any evidence entry recorded for this connection came from a
 * source other than `'transport-keepalive'`.
 */
function hasNonKeepaliveEvidence(evidence: readonly LivenessEvidenceEntry[]): boolean {
  return evidence.some((entry) => entry.source !== 'transport-keepalive');
}

/**
 * AB-219's AC2: the existing SSE `: heartbeat` comment write and WebSocket
 * pong are recorded as `evidenceSource: 'transport-keepalive'`, but that
 * source alone never resolves `reachability`/`progress` off `'unknown'` —
 * only `'host-reachability'` or another application-level signal may (none
 * exists yet for gateway connections; a future obs-* slice adds one).
 * `createStallWatchdog`'s generic cadence-gated `assess()` computes
 * `reachability`/`progress` from `missedPulseCount` alone, regardless of
 * which evidence source produced the pulses, so this clamp is applied here
 * rather than in the shared watchdog: a steady stream of transport-keepalive
 * pulses alone reads as `'unknown'`, not a self-referential `'reachable'`.
 * A missed-pulse decay (`'late'`/`'unreachable'`) still passes through
 * unclamped — that direction is genuine silence, not a false-positive
 * liveness claim.
 */
function clampGatewayConnectionAssessment(
  reachability: LivenessReachability,
  progress: LivenessProgressState,
  evidence: readonly LivenessEvidenceEntry[],
): { reachability: LivenessReachability; progress: LivenessProgressState } {
  if (hasNonKeepaliveEvidence(evidence)) {
    return { reachability, progress };
  }

  return {
    reachability: reachability === 'reachable' ? 'unknown' : reachability,
    progress: progress === 'progressing' ? 'unknown' : progress,
  };
}

function deriveGatewayConnectionAssessment(
  reachability: LivenessReachability,
  progress: LivenessProgressState,
): LivenessAssessment {
  if (reachability === 'unreachable') return 'unreachable';
  if (progress === 'stalled') return 'alive-but-stalled';
  return 'healthy';
}

function lastEvidenceAt(evidence: readonly LivenessEvidenceEntry[]): number | undefined {
  const last = evidence.at(-1);
  return last?.at;
}

function buildConnectionSnapshot(
  id: string,
  startedAt: string,
  watchdog: StallWatchdog,
  clock: StallWatchdogClock,
  revision: number,
): GatewayConnectionSnapshot {
  const raw = watchdog.assess();
  const { reachability, progress } = clampGatewayConnectionAssessment(
    raw.reachability,
    raw.progress,
    raw.evidence,
  );
  const lastHeartbeatAt = lastEvidenceAt(raw.evidence);

  return Object.freeze({
    id,
    kind: 'gateway-connection',
    startedAt,
    revision,
    status: 'running',
    lastTransitionAt: startedAt,
    projection: 'redacted',
    ownership: 'independent',
    detached: false,
    durability: 'process-local',
    cancellable: false,
    attempt: 0,
    reachability,
    progress,
    assessment: deriveGatewayConnectionAssessment(reachability, progress),
    observedAt: clock.now(),
    ...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
    missedPulseCount: raw.missedPulseCount,
    policyVersion: LIVENESS_POLICY_VERSION,
    evidence: raw.evidence,
  });
}

type Subscriber = {
  sendFrame: (frame: ServerFrame) => void;
  closeConnection: () => void;
  runIds: Set<string>;
  includeScheduler: boolean;
  /** AB-305: whether this connection's principal is privileged — see {@link LiveFrameSubscriberOptions.privileged}. */
  privileged: boolean;
  watchdog: StallWatchdog;
  /**
   * Records `evidenceSource: 'transport-keepalive'` pulse evidence AND
   * advances this connection's `LivenessSnapshot.revision` — the watchdog's
   * own `onAssessmentChange` only fires from its timer-driven missed-pulse
   * check (`watchdog.ts`), never from a `recordPulse` call itself, so a
   * revision advance from a fresh pulse has to happen here.
   */
  recordKeepalive(): void;
  snapshot(): GatewayConnectionSnapshot;
};

export type LiveFrameSubscriberOptions = {
  runIds?: Iterable<string>;
  includeScheduler?: boolean;
  /**
   * Ends this subscriber's underlying connection — a WebSocket close frame
   * or the end of an SSE stream, depending on transport. Invoked by
   * {@link LiveFrameBroker.closeAll} during gateway shutdown (AB-235) so
   * every open connection is asked to close before the server adapter's
   * own drain timeout elapses. Defaults to a no-op so callers that never
   * need coordinated shutdown (most existing subscribers/tests) aren't
   * required to supply one.
   */
  closeConnection?: () => void;
  /**
   * This connection's own heartbeat cadence, in milliseconds. Drives both
   * the SSE heartbeat interval (when applicable) and this connection's
   * `gateway-connection` `StallPolicy` cadence (AB-219). Defaults to
   * {@link DEFAULT_HEARTBEAT_INTERVAL_MS} — the same default the SSE
   * transport already uses — so a WebSocket connection (which has no
   * server-initiated heartbeat option today) is still classified against a
   * concrete cadence rather than an undefined one.
   */
  heartbeatIntervalMs?: number;
  /**
   * Whether this connection's principal is privileged (AB-305) — the same
   * "admin key" definition {@link isPrivilegedGatewayConnection} applies:
   * an unrestricted managed key, a static-token principal, or no auth
   * configured at all. Defaults to `false` (redaction is the connection's
   * default; privilege is opt-in) so a caller that never resolves this —
   * most existing subscribers/tests — gets the safer, redacted projection
   * of `response.validated` rather than silently leaking `original`.
   */
  privileged?: boolean;
};

export type EventStreamResponseOptions = LiveFrameSubscriberOptions & {
  initialFrames?: readonly ServerFrame[];
};

function isSchedulerFrame(
  frame: ServerFrame,
): frame is Extract<ServerFrame, { type: 'scheduler.state' | 'scheduler.task.preempted' }> {
  return frame.type === 'scheduler.state' || frame.type === 'scheduler.task.preempted';
}

function getRunId(frame: ServerFrame): string | undefined {
  if ('runId' in frame && typeof frame.runId === 'string') {
    return frame.runId;
  }

  return undefined;
}

/**
 * Reads the AB-15 per-run sequence number off a frame, when it carries one.
 * Only run-scoped frames (`event`, `stream:*`) carry `runSeq`; control frames
 * (`subscribed`, `pong`, `scheduler.*`, …) do not.
 */
function getRunSeq(frame: ServerFrame): number | undefined {
  return 'runSeq' in frame ? frame.runSeq : undefined;
}

// ── AB-305: response.validated wire projection ─────────────────────────

const RESPONSE_VALIDATED_EVENT_TYPE = 'response.validated';

/**
 * What a non-privileged connection sees in place of `response.validated`'s
 * `original` field — the coordinator's AB-305 ruling on AB-302: the
 * in-process `ResponseValidatedEvent` keeps its full pre/post diff
 * contract (`original` vs `validated`), but the gateway's live wire
 * projection replaces `original` with this marker for any connection whose
 * principal is not privileged. Same shape as the `GenerateResponse`
 * `original` normally carries (`content`, `toolCalls`) with the content
 * actually removed, never redacted in place — a wholesale substitution
 * needs no validator that knows what to look for, unlike AB-302's
 * guardrail-driven `action: 'redact'`. `usage`/`metadata` are omitted
 * outright rather than passed through, since either could still carry
 * pre-guardrail content.
 */
const RESPONSE_VALIDATED_REDACTION_MARKER: Readonly<Record<string, unknown>> = Object.freeze({
  content: '[redacted]',
  // This marker is a shared singleton reused across every projected frame
  // for every non-privileged subscriber — `Object.freeze` is shallow, so
  // the nested array must be frozen too, or an accidental downstream
  // mutation of `toolCalls` (e.g. `.push()`) would leak across every
  // subscriber and frame that reused this same object (copilot review).
  toolCalls: Object.freeze([]),
});

/** The shape `response.validated`'s frame `detail` carries — see `ResponseValidatedEvent`. */
interface ResponseValidatedDetail {
  readonly step: unknown;
  readonly original: unknown;
  readonly validated: unknown;
}

function isResponseValidatedDetail(detail: unknown): detail is ResponseValidatedDetail {
  return (
    typeof detail === 'object' &&
    detail !== null &&
    'step' in detail &&
    'original' in detail &&
    'validated' in detail
  );
}

/**
 * Projects one frame for delivery to a connection with the given
 * privilege, per AB-305's coordinator ruling. A no-op for every frame
 * except `response.validated` delivered to a non-privileged connection,
 * where `detail.original` is replaced by {@link RESPONSE_VALIDATED_REDACTION_MARKER}.
 * Applied at every point a frame reaches the wire — live broadcast, SSE
 * replay, and WebSocket `subscribe` replay — never at recording time, so
 * the in-memory replay buffer (and the durable audit trail, which reads
 * the bureau's own action log directly, never through this broker) always
 * holds the full, unprojected frame.
 */
function projectFrameForPrivilege(frame: ServerFrame, privileged: boolean): ServerFrame {
  if (privileged) return frame;
  if (frame.type !== 'event' || frame.event !== RESPONSE_VALIDATED_EVENT_TYPE) return frame;
  if (!isResponseValidatedDetail(frame.detail)) return frame;

  return {
    ...frame,
    detail: {
      ...frame.detail,
      original: RESPONSE_VALIDATED_REDACTION_MARKER,
    },
  };
}

/**
 * Encodes a per-run replay cursor as a compact string suitable for an SSE
 * `id:` field (and, symmetrically, a `since` query param on manual
 * reconnect). One SSE connection can multiplex several runs, so the cursor
 * is a full `runId -> runSeq` map, not a single scalar — otherwise resuming
 * would only be correct for whichever run happened to emit the most recent
 * frame.
 */
function encodeCursor(cursor: ReadonlyMap<string, number>): string {
  return [...cursor.entries()]
    .map(([runId, seq]) => `${encodeURIComponent(runId)}:${seq}`)
    .join(',');
}

/**
 * Inverse of {@link encodeCursor}. Tolerant of malformed/empty input: an
 * unparseable pair (bad percent-encoding, a non-integer/negative sequence)
 * is skipped rather than thrown, so one bad entry in a multi-run cursor
 * cannot take down the whole SSE handler.
 */
function decodeCursor(raw: string | null | undefined): Map<string, number> {
  const cursor = new Map<string, number>();
  if (!raw) {
    return cursor;
  }

  for (const pair of raw.split(',')) {
    const [encodedRunId, rawSeq] = pair.split(':');
    if (!encodedRunId || rawSeq === undefined) {
      continue;
    }

    const seq = Number(rawSeq);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      continue;
    }

    try {
      cursor.set(decodeURIComponent(encodedRunId), seq);
    } catch {
      // Malformed percent-encoding (e.g. a lone `%zz`) — skip this pair
      // instead of throwing out of the request handler.
    }
  }

  return cursor;
}

function formatEventStreamPayload(frame: ServerFrame, id?: string): string {
  const payload = JSON.stringify(frame);
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}data: ${payload.replace(/\n/g, '\ndata: ')}\n\n`;
}

/**
 * Tracks live-frame subscribers for both WebSocket and EventSource transports.
 */
export class LiveFrameBroker {
  private readonly subscribers = new Map<object, Subscriber>();
  /**
   * Set by {@link closeAll} during gateway shutdown (AB-235). Once true, a
   * subscriber that registers afterward — e.g. an SSE request that was
   * already in-flight through async authentication or rate-limiting when
   * `stop()` called `closeAll()` — is closed immediately by
   * {@link addSubscriber} instead of being left open for the rest of the
   * drain timeout.
   */
  private closing = false;
  /**
   * AB-15 replay buffers, one per run, holding the last {@link RUN_FRAME_BUFFER_LIMIT}
   * run-scoped frames emitted for that run (regardless of whether anyone was
   * subscribed when they were emitted — a reconnect from zero must still be
   * able to catch up). Recorded unconditionally in {@link broadcast}, ahead of
   * the per-subscriber dispatch, and read back by {@link getFramesSince} /
   * {@link subscribe} on reconnect.
   */
  private readonly runFrameBuffers = new Map<string, ServerFrame[]>();
  /** The clock seam driving both the SSE heartbeat interval and every connection's watchdog (AB-219). */
  private readonly clock: LiveFrameBrokerClock;
  /** Monotonic per-broker counter used to mint each connection's `LivenessSnapshot.id`. */
  private nextConnectionId = 0;

  constructor(options: LiveFrameBrokerOptions = {}) {
    this.clock = options.clock ?? realClock;
  }

  addSubscriber(
    key: object,
    sendFrame: (frame: ServerFrame) => void,
    options: LiveFrameSubscriberOptions = {},
  ): void {
    const closeConnection = options.closeConnection ?? (() => undefined);
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    // `LivenessSnapshot.revision` (AB-219 review): advances whenever this
    // connection's watchdog assessment changes — either the timer-driven
    // missed-pulse check (`onAssessmentChange`, below) or a fresh pulse
    // recorded directly (`recordKeepalive`, which `onAssessmentChange`
    // alone does not cover — see its own doc comment).
    let revision = 0;
    const bumpRevision = () => {
      revision += 1;
    };
    const watchdog = createStallWatchdog(gatewayConnectionPolicy(heartbeatIntervalMs), this.clock, {
      onAssessmentChange: bumpRevision,
    });
    const connectionId = `gateway-connection-${(this.nextConnectionId += 1)}`;
    const startedAt = this.clock.nowISO();
    const clock = this.clock;
    this.subscribers.set(key, {
      sendFrame,
      closeConnection,
      runIds: new Set(options.runIds ?? []),
      includeScheduler: options.includeScheduler ?? false,
      privileged: options.privileged ?? false,
      watchdog,
      recordKeepalive: () => {
        watchdog.recordPulse('transport-keepalive', 0);
        bumpRevision();
      },
      snapshot: () => buildConnectionSnapshot(connectionId, startedAt, watchdog, clock, revision),
    });
    if (this.closing) {
      // AB-235: shutdown already asked every existing connection to close
      // before this one registered — don't let it hold the drain window
      // open for the rest of the timeout.
      closeConnection();
    }
  }

  /**
   * Records `evidenceSource: 'transport-keepalive'` pulse evidence for
   * `key`'s connection watchdog (AB-219, AB-88's AC2/AC5). Used by the
   * existing SSE `: heartbeat` comment write and WebSocket pong response —
   * neither of which changes behavior on the wire; this only feeds the
   * application-level watchdog the fact that the transport-level keepalive
   * fired. A no-op if `key` is not (or is no longer) a tracked subscriber.
   */
  recordTransportKeepalive(key: object): void {
    this.subscribers.get(key)?.recordKeepalive();
  }

  /**
   * This broker's own `subscribers` map, surfaced under a stable name for
   * watchdog/health consumers (AB-219) — not a duplicate registry
   * maintained in parallel.
   */
  getConnectionRegistry(): ReadonlyMap<object, { snapshot(): LivenessSnapshot }> {
    return this.subscribers;
  }

  /**
   * Subscribes `key` to `runId` and returns the buffered frames with
   * `runSeq > since` (all buffered frames when `since` is omitted). Adding
   * to the live subscription set and reading the replay buffer happen in
   * the same synchronous call — with no `await` between them, no frame
   * emitted after this call can be missed, and none already covered by the
   * replay can be double-delivered, because nothing else can run on this
   * (single) thread until this function returns.
   *
   * AB-305: every returned frame is projected for this subscriber's own
   * privilege — a reconnecting non-privileged WebSocket client must not
   * see a buffered `response.validated.original` any more than a live one
   * does.
   */
  subscribe(key: object, runId: string, since?: number): ServerFrame[] {
    const subscriber = this.subscribers.get(key);
    if (!subscriber) {
      return [];
    }

    subscriber.runIds.add(runId);
    return this.getFramesSince(runId, since).map((frame) =>
      projectFrameForPrivilege(frame, subscriber.privileged),
    );
  }

  unsubscribe(key: object, runId: string): void {
    const subscriber = this.subscribers.get(key);
    if (!subscriber) {
      return;
    }

    subscriber.runIds.delete(runId);
  }

  removeSubscriber(key: object): void {
    this.subscribers.get(key)?.watchdog.dispose();
    this.subscribers.delete(key);
  }

  /**
   * Returns buffered frames for `runId` with `runSeq > since`, in original
   * emission order. `since` omitted means a fresh subscription with nothing
   * to resume — per the client-frame contract (`subscribe.since` unset on
   * first subscribe, see `use-websocket.svelte.ts`), that means NO replay,
   * not "replay everything": a first-time subscriber typically already has
   * the run's history from its initial page load, and re-delivering the
   * whole buffer would duplicate it. Callers that genuinely want the full
   * buffer (an explicit "reconnect from the beginning") pass `since: 0`.
   * A `since` older than the buffer's floor (post-trim) returns only what
   * remains — see the {@link RUN_FRAME_BUFFER_LIMIT} doc comment.
   */
  getFramesSince(runId: string, since?: number): ServerFrame[] {
    if (since === undefined) {
      return [];
    }

    const buffer = this.runFrameBuffers.get(runId);
    if (!buffer) {
      return [];
    }

    return buffer.filter((frame) => (getRunSeq(frame) ?? 0) > since);
  }

  /** Drops a run's replay buffer, e.g. once the run is deleted from the bureau. */
  clearRunBuffer(runId: string): void {
    this.runFrameBuffers.delete(runId);
  }

  private recordFrame(frame: ServerFrame): void {
    const runId = getRunId(frame);
    const runSeq = getRunSeq(frame);
    if (runId === undefined || runSeq === undefined) {
      return;
    }

    let buffer = this.runFrameBuffers.get(runId);
    if (!buffer) {
      buffer = [];
      this.runFrameBuffers.set(runId, buffer);
    }

    buffer.push(frame);
    if (buffer.length > RUN_FRAME_BUFFER_LIMIT) {
      buffer.splice(0, buffer.length - RUN_FRAME_BUFFER_LIMIT);
    }
  }

  /**
   * Fans `frame` out to every matching subscriber, recording it into the
   * per-run replay buffer first (unprojected — see {@link projectFrameForPrivilege}'s
   * doc comment) and then projecting a fresh copy for each subscriber's own
   * privilege (AB-305) before invoking its `sendFrame`.
   */
  broadcast(frame: ServerFrame): void {
    this.recordFrame(frame);
    const failedSubscribers: object[] = [];

    for (const [key, subscriber] of this.subscribers.entries()) {
      if (isSchedulerFrame(frame)) {
        if (!subscriber.includeScheduler) {
          continue;
        }
      } else {
        const runId = getRunId(frame);
        if (!runId) {
          continue;
        }

        if (!subscriber.runIds.has(runId) && !subscriber.runIds.has(ALL_RUNS_SUBSCRIPTION)) {
          continue;
        }
      }

      try {
        subscriber.sendFrame(projectFrameForPrivilege(frame, subscriber.privileged));
      } catch {
        failedSubscribers.push(key);
      }
    }

    for (const key of failedSubscribers) {
      this.removeSubscriber(key);
    }
  }

  getSubscriberCount(runId: string): number {
    let count = 0;

    for (const subscriber of this.subscribers.values()) {
      if (subscriber.runIds.has(runId) || subscriber.runIds.has(ALL_RUNS_SUBSCRIPTION)) {
        count += 1;
      }
    }

    return count;
  }

  /**
   * Total number of connections this broker is currently tracking, across
   * both WebSocket and SSE transports. Read by gateway shutdown (AB-235)
   * right before escalating to a force-close, to report how many
   * connections were still open at that point.
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Ends every connection this broker is tracking by invoking each
   * subscriber's registered {@link LiveFrameSubscriberOptions.closeConnection}
   * — a WebSocket close frame, or the end of an SSE stream. This is the
   * "drain rather than abandon" step of gateway shutdown (AB-235, per the
   * AB-37 decision record): every connection is told to close before the
   * server adapter's own `stop()` is raced against the drain timeout.
   *
   * Does not itself remove subscribers — each connection's own close
   * handling (SSE's internal `close()`, the WebSocket handler's `close`
   * event) does that once the underlying transport actually finishes
   * closing, which may happen after this call returns.
   *
   * Also marks the broker as closing (see {@link closing}) and tolerates
   * an individual `closeConnection` throwing — mirroring {@link broadcast}'s
   * per-subscriber isolation — so one misbehaving connection can't abort
   * the drain early and leave the rest of the connections un-asked.
   */
  closeAll(): void {
    this.closing = true;
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.closeConnection();
      } catch {
        // Isolated per subscriber, same as broadcast() — one connection's
        // close callback throwing must not stop the rest from being asked
        // to close too.
      }
    }
  }

  createEventStreamResponse(request: Request, options: EventStreamResponseOptions = {}): Response {
    const streamKey = {};
    const encoder = new TextEncoder();
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const privileged = options.privileged ?? false;
    let heartbeat: unknown;
    let closed = false;
    let controllerForClose: ReadableStreamDefaultController<Uint8Array> | undefined;

    // AB-15 resume cursor. The `Last-Event-ID` header carries a browser's own
    // automatic EventSource reconnect; the `since` query param carries a
    // *manual* reconnect — this codebase's client tears down and constructs a
    // fresh EventSource on failure (use-websocket.svelte.ts), which does not
    // preserve Last-Event-ID, so callers doing a manual reconnect must pass
    // `since` explicitly. The header wins when both are present.
    const requestUrl = new URL(request.url);
    // An empty `Last-Event-ID` header (some clients send it blank rather than
    // omitting it) must not shadow a real `?since=` query param — treat empty
    // string the same as absent.
    const lastEventIdHeader = request.headers.get('last-event-id');
    const resumeCursor = decodeCursor(lastEventIdHeader || requestUrl.searchParams.get('since'));
    // Tracks the highest `runSeq` sent per run over this connection's
    // lifetime, seeded from the resume cursor. Each frame's SSE `id:` line
    // carries the full cursor (not just that frame's own runSeq) so a
    // subsequent reconnect resumes correctly for every run multiplexed onto
    // this one connection, not just whichever run happened to emit last.
    const seenCursor = new Map(resumeCursor);

    const cleanup = () => {
      if (closed) {
        return false;
      }

      closed = true;
      if (heartbeat !== undefined) {
        this.clock.clearInterval(heartbeat);
        heartbeat = undefined;
      }
      this.removeSubscriber(streamKey);
      return true;
    };

    const close = () => {
      if (!cleanup()) {
        return;
      }

      if (!controllerForClose) {
        return;
      }

      try {
        controllerForClose.close();
      } catch {
        // Ignore double-close errors during cancellation.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerForClose = controller;

        const sendFrame = (frame: ServerFrame) => {
          if (closed) {
            return;
          }

          const runId = getRunId(frame);
          const runSeq = getRunSeq(frame);
          if (runId !== undefined && runSeq !== undefined) {
            const previous = seenCursor.get(runId) ?? 0;
            if (runSeq > previous) {
              seenCursor.set(runId, runSeq);
            }
          }

          const id = runId !== undefined ? encodeCursor(seenCursor) : undefined;

          try {
            controller.enqueue(encoder.encode(formatEventStreamPayload(frame, id)));
          } catch {
            close();
          }
        };

        this.addSubscriber(streamKey, sendFrame, { ...options, closeConnection: close });

        // AB-235: addSubscriber() above closes this stream synchronously
        // (via closeConnection) when the broker is already shutting down —
        // e.g. this request was in-flight through async auth/rate-limiting
        // when stop() called closeAll(). The controller is closed at that
        // point, so nothing below may enqueue anything further.
        if (closed) {
          return;
        }

        // AB-15 replay: for every explicitly-named run (not the `*` wildcard —
        // there is no stable buffered position across an open-ended run set),
        // flush buffered frames newer than the client's reported cursor
        // before any new live frame for that run is sent. `addSubscriber`
        // above and this loop both run synchronously with no `await` between
        // them, so no live frame emitted from this point on can race ahead
        // of (or be missed by) this replay.
        for (const runId of options.runIds ?? []) {
          if (runId === ALL_RUNS_SUBSCRIPTION) {
            continue;
          }

          // AB-305: this replay bypasses `subscribe()`/`broadcast()` (it
          // reads the buffer directly), so it must project for this
          // connection's own privilege itself.
          for (const frame of this.getFramesSince(runId, resumeCursor.get(runId))) {
            sendFrame(projectFrameForPrivilege(frame, privileged));
          }
        }

        for (const frame of options.initialFrames ?? []) {
          sendFrame(frame);
        }

        controller.enqueue(encoder.encode(': connected\n\n'));

        heartbeat = this.clock.setInterval(() => {
          if (closed) {
            return;
          }

          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
            this.recordTransportKeepalive(streamKey);
          } catch {
            close();
          }
        }, heartbeatIntervalMs);

        request.signal.addEventListener('abort', close, { once: true });
      },
      cancel: () => {
        close();
      },
    });

    return new Response(stream, {
      headers: {
        // SSE content type and encoding.
        'content-type': 'text/event-stream; charset=utf-8',
        // Instruct all caches and CDNs not to buffer or transform this stream.
        'cache-control': 'no-cache, no-transform',
        // Ask Nginx (and Nginx-compatible proxies like AWS ALB) to disable its
        // response buffering for this connection. Without this, Nginx holds
        // chunks until its buffer fills, which breaks the real-time guarantee.
        'x-accel-buffering': 'no',
        // Prevent MIME sniffing. The browser must treat this response as
        // text/event-stream and not try to interpret it as something else.
        'x-content-type-options': 'nosniff',
        // Keep the TCP connection alive between events. Required for HTTP/1.1;
        // HTTP/2 handles multiplexing at the protocol layer and ignores this
        // header, so it is safe to include in both cases.
        connection: 'keep-alive',
      },
    });
  }
}
