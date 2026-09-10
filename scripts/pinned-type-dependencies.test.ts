import { describe, expect, it } from 'bun:test';

import { PINNED_TYPE_DEPENDENCIES } from './pinned-type-dependencies.ts';

describe('PINNED_TYPE_DEPENDENCIES', () => {
  it('pins every entry to an exact version, never a range', () => {
    for (const [name, version] of Object.entries(PINNED_TYPE_DEPENDENCIES)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('keeps @types/node on a line bun-types 1.3.14 compiles against (25 or newer)', () => {
    const version = PINNED_TYPE_DEPENDENCIES['@types/node'];
    expect(version).toBeDefined();
    const major = Number(version?.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(25);
  });
});
