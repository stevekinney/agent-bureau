import { describe, expect, it } from 'bun:test';

import { LiveFrameBroker } from './live-events';
import type { ServerFrame } from './types';

function createRunFrame(): ServerFrame {
  return {
    type: 'event',
    runId: 'run-1',
    event: 'run.completed',
    detail: { content: 'Done.' },
    sequence: 1,
    timestamp: Date.now(),
  };
}

describe('LiveFrameBroker', () => {
  it('keeps broadcasting when one subscriber throws', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];
    const failingSubscriber = {};
    const healthySubscriber = {};

    broker.addSubscriber(
      failingSubscriber,
      () => {
        throw new Error('socket closed');
      },
      { runIds: ['run-1'] },
    );
    broker.addSubscriber(healthySubscriber, (frame) => received.push(frame), { runIds: ['run-1'] });

    expect(() => broker.broadcast(createRunFrame())).not.toThrow();
    expect(received).toHaveLength(1);
    expect(broker.getSubscriberCount('run-1')).toBe(1);
  });

  it('does not broadcast control frames without a run identifier through run subscriptions', () => {
    const broker = new LiveFrameBroker();
    const received: ServerFrame[] = [];

    broker.addSubscriber({}, (frame) => received.push(frame), { runIds: ['run-1'] });
    broker.addSubscriber({}, (frame) => received.push(frame), {
      runIds: ['*'],
      includeScheduler: true,
    });

    broker.broadcast({ type: 'pong' });

    expect(received).toHaveLength(0);
  });
});
