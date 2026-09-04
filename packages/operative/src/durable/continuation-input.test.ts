import { describe, expect, it } from 'bun:test';

import {
  buildSignalContinuationInput,
  buildWakeupContinuationInput,
  isDeniedSignalPayload,
  isRejectedSignalPayload,
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

describe('isRejectedSignalPayload', () => {
  it('recognizes the AB-46-ratified reject sentinel with a required reason', () => {
    expect(isRejectedSignalPayload({ __abRejected: true, reason: 'not authorized' })).toBe(true);
  });

  it('rejects a sentinel with a missing reason', () => {
    expect(isRejectedSignalPayload({ __abRejected: true })).toBe(false);
  });

  it('rejects a sentinel with a non-string reason', () => {
    expect(isRejectedSignalPayload({ __abRejected: true, reason: 42 })).toBe(false);
  });

  it('rejects payloads that are not the reject sentinel', () => {
    expect(isRejectedSignalPayload({ approved: true })).toBe(false);
    expect(isRejectedSignalPayload({ __abRejected: false, reason: 'x' })).toBe(false);
    expect(isRejectedSignalPayload(undefined)).toBe(false);
    expect(isRejectedSignalPayload(null)).toBe(false);
    expect(isRejectedSignalPayload('a string')).toBe(false);
    expect(isRejectedSignalPayload(42)).toBe(false);
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
      rejected: false,
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
      rejected: false,
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
      rejected: false,
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
      rejected: false,
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
      rejected: false,
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
      rejected: false,
    };
    expect(renderSignalContinuation(input)).toBe('[signal:ping] [unserializable payload]');
  });

  it('renders a rejection with its reason, checked before the denied branch', () => {
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'human-response',
      payload: { __abRejected: true, reason: 'needs more detail' },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
      rejected: true,
      rejectionReason: 'needs more detail',
    };
    expect(renderSignalContinuation(input)).toBe(
      '[signal:human-response] rejected: needs more detail',
    );
  });

  it('renders the rejected branch even when denied is also true, proving reject is checked first', () => {
    const input: SignalContinuationInput = {
      kind: 'signal',
      signalName: 'human-response',
      payload: { __abRejected: true, reason: 'needs more detail' },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: true,
      denialReason: 'ignored because rejected wins',
      rejected: true,
      rejectionReason: 'needs more detail',
    };
    expect(renderSignalContinuation(input)).toBe(
      '[signal:human-response] rejected: needs more detail',
    );
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
      rejected: false,
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
      rejected: false,
      denialReason: 'budget exceeded',
    });
  });

  it('threads deliveredAt through for a rejected payload, checked before the denied sentinel', () => {
    const input = buildSignalContinuationInput(
      'human-response',
      { __abRejected: true, reason: 'needs more detail' },
      '2026-09-02T10:00:00.000Z',
    );
    expect(input).toEqual({
      kind: 'signal',
      signalName: 'human-response',
      payload: { __abRejected: true, reason: 'needs more detail' },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
      rejected: true,
      rejectionReason: 'needs more detail',
    });
  });

  it('takes the reject branch over the deny branch when a payload matches both sentinels', () => {
    // isDeniedSignalPayload only requires __abDenied: true (reason optional), so a
    // payload carrying both sentinel markers would also satisfy it — proving
    // buildSignalContinuationInput actually checks isRejectedSignalPayload first,
    // not merely that a reject-only payload happens to skip the deny branch.
    const input = buildSignalContinuationInput(
      'human-response',
      { __abRejected: true, __abDenied: true, reason: 'needs more detail' },
      '2026-09-02T10:00:00.000Z',
    );
    expect(input).toEqual({
      kind: 'signal',
      signalName: 'human-response',
      payload: { __abRejected: true, __abDenied: true, reason: 'needs more detail' },
      deliveredAt: '2026-09-02T10:00:00.000Z',
      denied: false,
      rejected: true,
      rejectionReason: 'needs more detail',
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
