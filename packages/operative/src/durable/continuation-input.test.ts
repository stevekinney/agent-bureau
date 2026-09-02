import { describe, expect, it } from 'bun:test';

import {
  buildSignalContinuationInput,
  isDeniedSignalPayload,
  renderSignalContinuation,
  type SignalContinuationInput,
} from './continuation-input';

describe('isDeniedSignalPayload', () => {
  it('recognizes the AB-41-ratified denial sentinel', () => {
    expect(isDeniedSignalPayload({ __abDenied: true })).toBe(true);
    expect(isDeniedSignalPayload({ __abDenied: true, reason: 'not authorized' })).toBe(true);
  });

  it('rejects payloads that are not the denial sentinel', () => {
    expect(isDeniedSignalPayload({ approved: true })).toBe(false);
    expect(isDeniedSignalPayload({ __abDenied: false })).toBe(false);
    expect(isDeniedSignalPayload(undefined)).toBe(false);
    expect(isDeniedSignalPayload(null)).toBe(false);
    expect(isDeniedSignalPayload('a string')).toBe(false);
    expect(isDeniedSignalPayload(42)).toBe(false);
  });
});

describe('renderSignalContinuation', () => {
  it('renders an ordinary delivered payload as fixed, parseable text', () => {
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'human-response',
      payload: { approved: true },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
    };
    expect(renderSignalContinuation(input)).toBe('[signal:human-response] {"approved":true}');
  });

  it('renders a denial with a reason', () => {
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'human-response',
      payload: { __abDenied: true, reason: 'budget exceeded' },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: true,
      denialReason: 'budget exceeded',
    };
    expect(renderSignalContinuation(input)).toBe('[signal:human-response] denied: budget exceeded');
  });

  it('renders a denial with no reason', () => {
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'human-response',
      payload: { __abDenied: true },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: true,
    };
    expect(renderSignalContinuation(input)).toBe('[signal:human-response] denied');
  });

  it('falls back to a fixed placeholder for a payload JSON.stringify cannot render', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'human-response',
      payload: circular,
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
    };
    expect(renderSignalContinuation(input)).toBe(
      '[signal:human-response] [unserializable payload]',
    );
  });

  it('renders undefined payload as the literal JSON.stringify output', () => {
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'ping',
      payload: undefined,
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
    };
    // JSON.stringify(undefined) is the JS value `undefined`, not a string —
    // rendered as the literal word so the message stays deterministic text.
    expect(renderSignalContinuation(input)).toBe('[signal:ping] undefined');
  });

  it('renders a bigint payload (JSON.stringify throws) as the placeholder', () => {
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'ping',
      payload: 10n,
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
    };
    expect(renderSignalContinuation(input)).toBe('[signal:ping] [unserializable payload]');
  });
});

describe('buildSignalContinuationInput', () => {
  it('threads deliveredAt through for an ordinary payload', () => {
    const input = buildSignalContinuationInput(
      'human-response',
      { approved: true },
      '2026-09-02T10:00:00.000Z',
    );
    expect(input).toEqual({
      kind: 'signal',
      signalName: 'human-response',
      payload: { approved: true },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
    });
  });

  it('threads deliveredAt through for a denied payload', () => {
    const input = buildSignalContinuationInput(
      'human-response',
      { __abDenied: true, reason: 'budget exceeded' },
      '2026-09-02T10:00:00.000Z',
    );
    expect(input).toEqual({
      kind: 'signal',
      signalName: 'human-response',
      payload: { __abDenied: true, reason: 'budget exceeded' },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: true,
      denialReason: 'budget exceeded',
    });
  });
});
