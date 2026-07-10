import { describe, expect, it } from 'bun:test';

import { filterByValidity, isValidAtTimestamp, stampSupersession } from '../src/temporal-validity';

describe('isValidAtTimestamp', () => {
  it('is valid when asOf is after createdAt and no invalidatedAt is set', () => {
    expect(isValidAtTimestamp({}, 1_000, 2_000)).toBe(true);
  });

  it('falls back to createdAt when validFrom is unset', () => {
    expect(isValidAtTimestamp({}, 1_000, 500)).toBe(false);
    expect(isValidAtTimestamp({}, 1_000, 1_000)).toBe(true);
  });

  it('honors an explicit validFrom that backdates a fact before createdAt', () => {
    // Recorded at 2_000 but true starting at 500.
    expect(isValidAtTimestamp({ validFrom: 500 }, 2_000, 700)).toBe(true);
    expect(isValidAtTimestamp({ validFrom: 500 }, 2_000, 400)).toBe(false);
  });

  it('is invalid once asOf reaches invalidatedAt (exclusive upper bound)', () => {
    const metadata = { invalidatedAt: 5_000 };
    expect(isValidAtTimestamp(metadata, 1_000, 4_999)).toBe(true);
    expect(isValidAtTimestamp(metadata, 1_000, 5_000)).toBe(false);
    expect(isValidAtTimestamp(metadata, 1_000, 5_001)).toBe(false);
  });

  it('is invalid before validFrom even if not yet invalidated', () => {
    expect(isValidAtTimestamp({ validFrom: 10_000 }, 1_000, 5_000)).toBe(false);
  });
});

describe('filterByValidity', () => {
  it('keeps only records valid at the given instant', () => {
    const results = [
      { id: 'a', createdAt: 1_000, metadata: {} },
      { id: 'b', createdAt: 1_000, metadata: { invalidatedAt: 3_000 } },
      { id: 'c', createdAt: 5_000, metadata: {} }, // not yet created at asOf=2_000
    ];

    expect(filterByValidity(results, 2_000).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterByValidity(results, 4_000).map((r) => r.id)).toEqual(['a']);
  });

  it('does not mutate the input array', () => {
    const results = [{ id: 'a', createdAt: 1_000, metadata: { invalidatedAt: 500 } }];
    const filtered = filterByValidity(results, 2_000);

    expect(filtered).toEqual([]);
    expect(results).toHaveLength(1);
  });
});

describe('stampSupersession', () => {
  it('returns a new object with supersededBy and invalidatedAt set', () => {
    const original = { tags: ['a'] };
    const stamped = stampSupersession(original, 'new-id', 9_000);

    expect(stamped).toEqual({ tags: ['a'], supersededBy: 'new-id', invalidatedAt: 9_000 });
    expect(original).toEqual({ tags: ['a'] }); // unchanged
  });

  it('overwrites a prior supersession stamp (last writer wins)', () => {
    const already = { supersededBy: 'old-successor', invalidatedAt: 1_000 };
    const stamped = stampSupersession(already, 'newer-successor', 2_000);

    expect(stamped.supersededBy).toBe('newer-successor');
    expect(stamped.invalidatedAt).toBe(2_000);
  });
});
