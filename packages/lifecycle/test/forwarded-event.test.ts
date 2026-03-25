import { describe, expect, it } from 'bun:test';

import { CompletableEventTarget } from '../src/completable';
import { ForwardedEvent, forwardEvents } from '../src/forwarded-event';

class ToolCallEvent extends Event {
  static readonly type = 'call' as const;
  readonly toolName: string;

  constructor(toolName: string) {
    super(ToolCallEvent.type);
    this.toolName = toolName;
  }
}

class ToolCompleteEvent extends Event {
  static readonly type = 'complete' as const;
  readonly result: string;

  constructor(result: string) {
    super(ToolCompleteEvent.type);
    this.result = result;
  }
}

interface SourceEventMap {
  [ToolCallEvent.type]: ToolCallEvent;
  [ToolCompleteEvent.type]: ToolCompleteEvent;
}

interface TargetEventMap {
  'toolbox.call': ForwardedEvent<ToolCallEvent>;
  'toolbox.complete': ForwardedEvent<ToolCompleteEvent>;
}

describe('ForwardedEvent', () => {
  it('has the correct type string', () => {
    const original = new ToolCallEvent('search');
    const forwarded = new ForwardedEvent('toolbox.call', original);

    expect(forwarded.type).toBe('toolbox.call');
  });

  it('preserves the original event instance', () => {
    const original = new ToolCallEvent('search');
    const forwarded = new ForwardedEvent('toolbox.call', original);

    expect(forwarded.originalEvent).toBe(original);
    expect(forwarded.originalEvent.toolName).toBe('search');
  });

  it('is an instance of Event', () => {
    const forwarded = new ForwardedEvent('toolbox.call', new ToolCallEvent('test'));
    expect(forwarded).toBeInstanceOf(Event);
    expect(forwarded).toBeInstanceOf(ForwardedEvent);
  });

  it('works with different original event types', () => {
    const original = new ToolCompleteEvent('success');
    const forwarded = new ForwardedEvent('toolbox.complete', original);

    expect(forwarded.type).toBe('toolbox.complete');
    expect(forwarded.originalEvent.result).toBe('success');
  });
});

describe('forwardEvents', () => {
  it('prefixes event types and dispatches ForwardedEvents on the target', () => {
    const source = new CompletableEventTarget<SourceEventMap>();
    const target = new CompletableEventTarget<TargetEventMap>();
    const received: ForwardedEvent[] = [];

    target.addEventListener('toolbox.call', (event) => received.push(event));

    forwardEvents(source, target, 'toolbox');

    source.dispatch(new ToolCallEvent('search'));

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('toolbox.call');
    expect(received[0]!.originalEvent).toBeInstanceOf(ToolCallEvent);
    expect((received[0]!.originalEvent as ToolCallEvent).toolName).toBe('search');

    source.complete();
  });

  it('forwards multiple event types', () => {
    const source = new CompletableEventTarget<SourceEventMap>();
    const target = new CompletableEventTarget<TargetEventMap>();
    const types: string[] = [];

    target.addEventListener('toolbox.call', (event) => types.push(event.type));
    target.addEventListener('toolbox.complete', (event) => types.push(event.type));

    forwardEvents(source, target, 'toolbox');

    source.dispatch(new ToolCallEvent('search'));
    source.dispatch(new ToolCompleteEvent('done'));

    expect(types).toEqual(['toolbox.call', 'toolbox.complete']);

    source.complete();
  });

  it('stops forwarding when stop() is called', () => {
    const source = new CompletableEventTarget<SourceEventMap>();
    const target = new CompletableEventTarget<TargetEventMap>();
    const received: ForwardedEvent[] = [];

    target.addEventListener('toolbox.call', (event) => received.push(event));

    const { stop } = forwardEvents(source, target, 'toolbox');

    source.dispatch(new ToolCallEvent('first'));
    stop();
    source.dispatch(new ToolCallEvent('second'));

    expect(received).toHaveLength(1);
    expect((received[0]!.originalEvent as ToolCallEvent).toolName).toBe('first');

    source.complete();
  });

  it('stops forwarding when signal is aborted', () => {
    const source = new CompletableEventTarget<SourceEventMap>();
    const target = new CompletableEventTarget<TargetEventMap>();
    const controller = new AbortController();
    const received: ForwardedEvent[] = [];

    target.addEventListener('toolbox.call', (event) => received.push(event));

    forwardEvents(source, target, 'toolbox', { signal: controller.signal });

    source.dispatch(new ToolCallEvent('first'));
    controller.abort();
    source.dispatch(new ToolCallEvent('second'));

    expect(received).toHaveLength(1);

    source.complete();
  });
});
