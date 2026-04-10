import type { ServerFrame } from './types';

export const ALL_RUNS_SUBSCRIPTION = '*';

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

function formatEventStreamPayload(frame: ServerFrame): string {
  const payload = JSON.stringify(frame);
  return `data: ${payload.replace(/\n/g, '\ndata: ')}\n\n`;
}

/**
 * Tracks live-frame subscribers for both WebSocket and EventSource transports.
 */
export class LiveFrameBroker {
  private readonly subscribers = new Map<object, Subscriber>();

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

  subscribe(key: object, runId: string): void {
    const subscriber = this.subscribers.get(key);
    if (!subscriber) {
      return;
    }

    subscriber.runIds.add(runId);
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

  broadcast(frame: ServerFrame): void {
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
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let controllerForClose: ReadableStreamDefaultController<Uint8Array> | undefined;

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

          try {
            controller.enqueue(encoder.encode(formatEventStreamPayload(frame)));
          } catch {
            close();
          }
        };

        this.addSubscriber(streamKey, sendFrame, options);

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
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });
  }
}
