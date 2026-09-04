import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import { applyTemporalDecay, computeTemporalDecay } from '../src/temporal-decay';

const ONE_HOUR = 60 * 60 * 1000;
// Fixed reference instant used by the tests below that assign it to `now`: each of those
// passes it explicitly as `referenceTime`, so its value only needs to be a stable epoch
// millisecond number, never the real clock. (The runtime-injection and empty-input tests
// further down don't use this constant at all — they derive their own time from a manual
// RuntimeServices, or need no time input.)
const FIXED_NOW = Date.parse('2026-01-01T00:00:00.000Z');

describe('computeTemporalDecay', () => {
  it('halves the score at exactly one half-life', () => {
    const now = FIXED_NOW;
    const createdAt = now - ONE_HOUR;
    const result = computeTemporalDecay(1.0, createdAt, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime: now,
    });
    expect(result).toBeCloseTo(0.5, 10);
  });

  it('quarters the score at two half-lives', () => {
    const now = FIXED_NOW;
    const createdAt = now - 2 * ONE_HOUR;
    const result = computeTemporalDecay(1.0, createdAt, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime: now,
    });
    expect(result).toBeCloseTo(0.25, 10);
  });

  it('leaves score unchanged at age 0', () => {
    const now = FIXED_NOW;
    const result = computeTemporalDecay(0.8, now, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime: now,
    });
    expect(result).toBeCloseTo(0.8, 10);
  });

  it('leaves score unchanged for future timestamps (negative age)', () => {
    const now = FIXED_NOW;
    const createdAt = now + ONE_HOUR; // in the future
    const result = computeTemporalDecay(0.9, createdAt, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime: now,
    });
    expect(result).toBeCloseTo(0.9, 10);
  });

  it('uses custom referenceTime correctly', () => {
    const referenceTime = 1_000_000;
    const createdAt = referenceTime - ONE_HOUR;
    const result = computeTemporalDecay(1.0, createdAt, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime,
    });
    expect(result).toBeCloseTo(0.5, 10);
  });

  it('derives the default referenceTime from an injected manual runtime rather than the real clock, when referenceTime is omitted', () => {
    const runtime = createManualRuntimeServices({ origin: '2026-04-10T00:00:00.000Z' });
    const createdAt = runtime.clock.now() - ONE_HOUR;

    const result = computeTemporalDecay(1.0, createdAt, {
      halfLifeMilliseconds: ONE_HOUR,
      runtime,
    });

    expect(result).toBeCloseTo(0.5, 10);
  });
});

describe('applyTemporalDecay', () => {
  it('exempts evergreen entries when evergreenExempt is true (default)', () => {
    const now = FIXED_NOW;
    const results = [
      { score: 1.0, createdAt: now - ONE_HOUR, metadata: { evergreen: true } },
      { score: 1.0, createdAt: now - ONE_HOUR, metadata: { evergreen: false } },
    ];

    const decayed = applyTemporalDecay(results, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime: now,
    });

    expect(decayed[0]!.score).toBeCloseTo(1.0, 10); // evergreen: untouched
    expect(decayed[1]!.score).toBeCloseTo(0.5, 10); // not evergreen: decayed
  });

  it('does NOT exempt evergreen entries when evergreenExempt is false', () => {
    const now = FIXED_NOW;
    const results = [{ score: 1.0, createdAt: now - ONE_HOUR, metadata: { evergreen: true } }];

    const decayed = applyTemporalDecay(results, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime: now,
      evergreenExempt: false,
    });

    expect(decayed[0]!.score).toBeCloseTo(0.5, 10);
  });

  it('returns an empty array for empty input', () => {
    const result = applyTemporalDecay([], {
      halfLifeMilliseconds: ONE_HOUR,
    });
    expect(result).toEqual([]);
  });

  it('does not mutate the original results', () => {
    const now = FIXED_NOW;
    const original = { score: 1.0, createdAt: now - ONE_HOUR, metadata: { evergreen: false } };
    const results = [original];

    applyTemporalDecay(results, {
      halfLifeMilliseconds: ONE_HOUR,
      referenceTime: now,
    });

    expect(original.score).toBe(1.0);
  });
});
