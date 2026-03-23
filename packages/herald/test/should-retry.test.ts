import { describe, expect, it } from 'bun:test';

import { HeraldError, shouldRetryHeraldError } from '../src/errors';

describe('shouldRetryHeraldError', () => {
  it('returns true for a retryable HeraldError (429)', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: { status: 429 },
    });

    expect(shouldRetryHeraldError(error)).toBe(true);
  });

  it('returns true for a retryable HeraldError (500)', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: { status: 500 },
    });

    expect(shouldRetryHeraldError(error)).toBe(true);
  });

  it('returns true for a retryable HeraldError (502)', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: { status: 502 },
    });

    expect(shouldRetryHeraldError(error)).toBe(true);
  });

  it('returns true for a retryable HeraldError (503)', () => {
    const error = new HeraldError({
      provider: 'gemini',
      cause: { status: 503 },
    });

    expect(shouldRetryHeraldError(error)).toBe(true);
  });

  it('returns true for a retryable HeraldError (504)', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: { status: 504 },
    });

    expect(shouldRetryHeraldError(error)).toBe(true);
  });

  it('returns false for a non-retryable HeraldError (401)', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: { status: 401 },
    });

    expect(shouldRetryHeraldError(error)).toBe(false);
  });

  it('returns false for a HeraldError without a status code', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: new Error('network failure'),
    });

    expect(shouldRetryHeraldError(error)).toBe(false);
  });

  it('returns false for a plain Error', () => {
    expect(shouldRetryHeraldError(new Error('random'))).toBe(false);
  });

  it('returns false for a non-Error value', () => {
    expect(shouldRetryHeraldError('string error')).toBe(false);
    expect(shouldRetryHeraldError(null)).toBe(false);
    expect(shouldRetryHeraldError(undefined)).toBe(false);
    expect(shouldRetryHeraldError(42)).toBe(false);
  });
});
