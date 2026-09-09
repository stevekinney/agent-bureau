// Fixture: a package's own unit test importing its own internal module via a relative import.
// Same-package internal imports are never reported, regardless of depth.
import { describe, expect, it } from 'bun:test';

import { internalThing } from './internal';

describe('pkg-a internals', () => {
  it('imports its own package internal module without being reported', () => {
    expect(internalThing).toBe('internal');
  });
});
