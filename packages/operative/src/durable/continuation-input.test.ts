import { describe, expect, it } from 'bun:test';

import {
  buildSignalContinuationInput,
  buildWakeupContinuationInput,
  isDeniedSignalPayload,
  renderDurationLabel,
  renderSignalContinuation,
  renderWakeupContinuation,
  type SignalContinuationInput,
  type WakeupContinuationInput,
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

describe('renderDurationLabel', () => {
  it('renders a numeric duration as milliseconds', () => {
    expect(renderDurationLabel(500)).toBe('500ms');
    expect(renderDurationLabel(0)).toBe('0ms');
  });

  it('renders a string duration unchanged', () => {
    expect(renderDurationLabel('6h')).toBe('6h');
    expect(renderDurationLabel('PT30M')).toBe('PT30M');
  });
});

describe('buildWakeupContinuationInput', () => {
  it('builds the AB-41-ratified shape with a note', () => {
    const input = buildWakeupContinuationInput(
      '6h',
      'Check the deploy status',
      '2026-09-02T10:00:00.000Z',
    );
    expect(input).toEqual({
      kind: 'wakeup',
      firedAt: '2026-09-02T10:00:00.000Z',
      requestedDuration: '6h',
      note: 'Check the deploy status',
    });
  });

  it('omits note when none was attached', () => {
    const input = buildWakeupContinuationInput(500, undefined, '2026-09-02T10:00:00.000Z');
    expect(input).toEqual({
      kind: 'wakeup',
      firedAt: '2026-09-02T10:00:00.000Z',
      requestedDuration: 500,
    });
    expect('note' in input).toBe(false);
  });
});

describe('renderWakeupContinuation', () => {
  it('renders a numeric duration with a note as fixed, parseable text', () => {
    const input: WakeupContinuationInput = {
      kind: 'wakeup',
      firedAt: '2026-09-02T10:00:00.000Z',
      requestedDuration: 21_600_000,
      note: 'Check the deploy status',
    };
    expect(renderWakeupContinuation(input)).toBe(
      '[wakeup] Resumed after sleeping 21600000ms. Note: Check the deploy status',
    );
  });

  it('renders a human-readable string duration with no note', () => {
    const input: WakeupContinuationInput = {
      kind: 'wakeup',
      firedAt: '2026-09-02T10:00:00.000Z',
      requestedDuration: '6h',
    };
    expect(renderWakeupContinuation(input)).toBe('[wakeup] Resumed after sleeping 6h.');
  });
});
