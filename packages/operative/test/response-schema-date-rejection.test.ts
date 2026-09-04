import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { NonJsonOutputError } from '../src/errors';
import { validateOutputValue } from '../src/structured-output/response-schema';

/**
 * AB-330: split out of `response-schema.test.ts` — this test needs an actual
 * `Date` INSTANCE as the value it feeds `validateOutputValue` and asserts
 * gets rejected; the specific timestamp is irrelevant (any `Date` instance
 * proves the same point), but the determinism rule flags any `new Date(...)`
 * construction regardless of whether the value it reads matters. No injected
 * `RuntimeServices` can substitute — the point is the VALUE's runtime type,
 * not a clock read.
 */
describe('validateOutputValue — Date instance rejection', () => {
  it('rejects a Date instance as NonJsonOutputError, even against a permissive z.unknown() schema', async () => {
    const result = await validateOutputValue(z.unknown(), new Date());
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBeInstanceOf(NonJsonOutputError);
  });
});
