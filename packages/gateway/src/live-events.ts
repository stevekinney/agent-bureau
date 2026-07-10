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

type Subscriber = {
  sendFrame: (frame: ServerFrame) => void;
  runIds: Set<string>;
  includeScheduler: boolean;
};

export type LiveFrameSubscriberOptions = {
  runIds?: Iterable<string>;
  includeScheduler?: boolean;
};

export type EventStreamResponseOptions = LiveFrameSubscriberOptions & {
  heartbeatIntervalMs?: number;
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

/** Inverse of {@link encodeCursor}. Tolerant of malformed/empty input. */
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
    if (Number.isFinite(seq)) {
      cursor.set(decodeURIComponent(encodedRunId), seq);
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
   * AB-15 replay buffers, one per run, holding the last {@link RUN_FRAME_BUFFER_LIMIT}
   * run-scoped frames emitted for that run (regardless of whether anyone was
   * subscribed when they were emitted — a reconnect from zero must still be
   * able to catch up). Recorded unconditionally in {@link broadcast}, ahead of
   * the per-subscriber dispatch, and read back by {@link getFramesSince} /
   * {@link subscribe} on reconnect.
   */
  private readonly runFrameBuffers = new Map<string, ServerFrame[]>();

  addSubscriber(
    key: object,
    sendFrame: (frame: ServerFrame) => void,
    options: LiveFrameSubscriberOptions = {},
  ): void {
    this.subscribers.set(key, {
      sendFrame,
      runIds: new Set(options.runIds ?? []),
      includeScheduler: options.includeScheduler ?? false,
    });
  }

  /**
   * Subscribes `key` to `runId` and returns the buffered frames with
   * `runSeq > since` (all buffered frames when `since` is omitted). Adding
   * to the live subscription set and reading the replay buffer happen in
   * the same synchronous call — with no `await` between them, no frame
   * emitted after this call can be missed, and none already covered by the
   * replay can be double-delivered, because nothing else can run on this
   * (single) thread until this function returns.
   */
  subscribe(key: object, runId: string, since?: number): ServerFrame[] {
    const subscriber = this.subscribers.get(key);
    if (!subscriber) {
      return [];
    }

    subscriber.runIds.add(runId);
    return this.getFramesSince(runId, since);
  }

  unsubscribe(key: object, runId: string): void {
    const subscriber = this.subscribers.get(key);
    if (!subscriber) {
      return;
    }

    subscriber.runIds.delete(runId);
  }

  removeSubscriber(key: object): void {
    this.subscribers.delete(key);
  }

  /**
   * Returns buffered frames for `runId` with `runSeq > since` (or every
   * buffered frame when `since` is omitted), in original emission order.
   * A `since` older than the buffer's floor (post-trim) returns only what
   * remains — see the {@link RUN_FRAME_BUFFER_LIMIT} doc comment.
   */
  getFramesSince(runId: string, since?: number): ServerFrame[] {
    const buffer = this.runFrameBuffers.get(runId);
    if (!buffer) {
      return [];
    }

    if (since === undefined) {
      return [...buffer];
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
        subscriber.sendFrame(frame);
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

  createEventStreamResponse(request: Request, options: EventStreamResponseOptions = {}): Response {
    const streamKey = {};
    const encoder = new TextEncoder();
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let controllerForClose: ReadableStreamDefaultController<Uint8Array> | undefined;

    // AB-15 resume cursor. The `Last-Event-ID` header carries a browser's own
    // automatic EventSource reconnect; the `since` query param carries a
    // *manual* reconnect — this codebase's client tears down and constructs a
    // fresh EventSource on failure (use-websocket.svelte.ts), which does not
    // preserve Last-Event-ID, so callers doing a manual reconnect must pass
    // `since` explicitly. The header wins when both are present.
    const requestUrl = new URL(request.url);
    const resumeCursor = decodeCursor(
      request.headers.get('last-event-id') ?? requestUrl.searchParams.get('since'),
    );
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
      if (heartbeat) {
        clearInterval(heartbeat);
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

        this.addSubscriber(streamKey, sendFrame, options);

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

          for (const frame of this.getFramesSince(runId, resumeCursor.get(runId))) {
            sendFrame(frame);
          }
        }

        for (const frame of options.initialFrames ?? []) {
          sendFrame(frame);
        }

        controller.enqueue(encoder.encode(': connected\n\n'));

        heartbeat = setInterval(() => {
          if (closed) {
            return;
          }

          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
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
