import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { NonJsonOutputError } from '../src/errors';
import { validateOutputValue } from '../src/structured-output/response-schema';

/**
 * AB-348: split out of `response-schema.test.ts` (originally AB-330). This
 * test needs an actual `Date` INSTANCE as the value it feeds
 * `validateOutputValue` and asserts gets rejected — the specific timestamp
 * is irrelevant, only the VALUE's runtime type matters. The determinism
 * gate's `no-real-runtime-call` rule flags `new Date()` (zero-argument form)
 * specifically because that reads the real wall clock; `new Date(0)`
 * constructs a `Date` instance from a fixed literal epoch value and reads no
 * clock at all, so it is not flagged and needs no `RuntimeServices`
 * injection or exemption.
 */
describe('validateOutputValue — Date instance rejection', () => {
  it('rejects a Date instance as NonJsonOutputError, even against a permissive z.unknown() schema', async () => {
    const result = await validateOutputValue(z.unknown(), new Date(0));
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toBeInstanceOf(NonJsonOutputError);
  });
});
