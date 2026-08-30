import { describe, expect, test } from 'bun:test';

import { findStaleDistPackages } from './check-stale-workspace-dist';

describe('findStaleDistPackages', () => {
  test('returns an empty array when every package is at least as new as its dist/', () => {
    const stale = findStaleDistPackages([
      { name: 'armorer', newestSourceMtimeMs: 100, newestDistMtimeMs: 200 },
      { name: 'conversationalist', newestSourceMtimeMs: 100, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual([]);
  });

  test('names a package whose dist/ predates its src/', () => {
    const stale = findStaleDistPackages([
      { name: 'conversationalist', newestSourceMtimeMs: 200, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual(['conversationalist']);
  });

  test('names every stale package, sorted, and omits fresh ones', () => {
    const stale = findStaleDistPackages([
      { name: '@lostgradient/operative', newestSourceMtimeMs: 300, newestDistMtimeMs: 100 },
      { name: 'armorer', newestSourceMtimeMs: 100, newestDistMtimeMs: 200 },
      { name: 'conversationalist', newestSourceMtimeMs: 200, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual(['@lostgradient/operative', 'conversationalist']);
  });

  test('returns an empty array for an empty input', () => {
    expect(findStaleDistPackages([])).toEqual([]);
  });

  test('treats an exactly-equal mtime as fresh, not stale', () => {
    const stale = findStaleDistPackages([
      { name: 'armorer', newestSourceMtimeMs: 100, newestDistMtimeMs: 100 },
    ]);

    expect(stale).toEqual([]);
  });
});
