import { describe, expect, it } from 'bun:test';

import { FalloverExhaustedError } from './errors.ts';

describe('FalloverExhaustedError', () => {
  it('is an instance of Error', () => {
    const error = new FalloverExhaustedError([
      { provider: 'anthropic', error: new Error('auth failed') },
    ]);
    expect(error).toBeInstanceOf(Error);
  });

  it('contains all provider errors', () => {
    const errors = [
      { provider: 'anthropic', error: new Error('auth failed') },
      { provider: 'openai', error: new Error('rate limited') },
      { provider: 'gemini', error: new Error('server error') },
    ];
    const error = new FalloverExhaustedError(errors);

    expect(error.errors).toHaveLength(3);
    expect(error.errors[0]!.provider).toBe('anthropic');
    expect(error.errors[1]!.provider).toBe('openai');
    expect(error.errors[2]!.provider).toBe('gemini');
  });

  it('sets lastError to the final provider error', () => {
    const lastProviderError = new Error('server error');
    const errors = [
      { provider: 'anthropic', error: new Error('auth failed') },
      { provider: 'openai', error: lastProviderError },
    ];
    const error = new FalloverExhaustedError(errors);

    expect(error.lastError).toBe(lastProviderError);
  });

  it('has a descriptive message', () => {
    const errors = [
      { provider: 'anthropic', error: new Error('auth failed') },
      { provider: 'openai', error: new Error('rate limited') },
    ];
    const error = new FalloverExhaustedError(errors);

    expect(error.message).toContain('All 2 providers failed');
  });

  it('has the name FalloverExhaustedError', () => {
    const error = new FalloverExhaustedError([{ provider: 'test', error: new Error('fail') }]);
    expect(error.name).toBe('FalloverExhaustedError');
  });

  it('errors array is readonly', () => {
    const errors = [{ provider: 'anthropic', error: new Error('fail') }];
    const error = new FalloverExhaustedError(errors);

    // TypeScript enforces readonly, but verify the array is a new reference
    expect(error.errors).not.toBe(errors);
  });
});
