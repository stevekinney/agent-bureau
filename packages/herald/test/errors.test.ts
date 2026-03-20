import { describe, expect, it } from 'bun:test';

import { HeraldError } from '../src/errors';

describe('HeraldError', () => {
  it('sets name to HeraldError', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: new Error('test'),
    });

    expect(error.name).toBe('HeraldError');
  });

  it('sets provider to anthropic', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: new Error('test'),
    });

    expect(error.provider).toBe('anthropic');
  });

  it('sets provider to openai', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: new Error('test'),
    });

    expect(error.provider).toBe('openai');
  });

  it('sets provider to gemini', () => {
    const error = new HeraldError({
      provider: 'gemini',
      cause: new Error('test'),
    });

    expect(error.provider).toBe('gemini');
  });

  it('preserves the original cause', () => {
    const cause = new Error('original SDK error');
    const error = new HeraldError({ provider: 'anthropic', cause });

    expect(error.cause).toBe(cause);
  });

  it('uses a custom message when provided', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: new Error('SDK failure'),
      message: 'Custom error message',
    });

    expect(error.message).toBe('Custom error message');
  });

  it('auto-generates a message with [herald:provider] prefix from an Error cause', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: new Error('rate limited'),
    });

    expect(error.message).toBe('[herald:anthropic] rate limited');
  });

  it('auto-generates a message from a string cause', () => {
    const error = new HeraldError({
      provider: 'gemini',
      cause: 'something went wrong',
    });

    expect(error.message).toBe('[herald:gemini] something went wrong');
  });

  it('auto-generates an unknown error message when cause is not a string or Error', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: 42,
    });

    expect(error.message).toBe('[herald:openai] Unknown error');
  });

  it('extracts statusCode from error.status', () => {
    const cause = { status: 429, message: 'Too Many Requests' };
    const error = new HeraldError({ provider: 'anthropic', cause });

    expect(error.statusCode).toBe(429);
  });

  it('extracts statusCode from error.statusCode', () => {
    const cause = { statusCode: 500, message: 'Internal Server Error' };
    const error = new HeraldError({ provider: 'openai', cause });

    expect(error.statusCode).toBe(500);
  });

  it('extracts statusCode from error.error.status', () => {
    const cause = { error: { status: 503 } };
    const error = new HeraldError({ provider: 'gemini', cause });

    expect(error.statusCode).toBe(503);
  });

  it('uses the constructor statusCode option over the extracted one', () => {
    const cause = { status: 500 };
    const error = new HeraldError({
      provider: 'anthropic',
      cause,
      statusCode: 503,
    });

    expect(error.statusCode).toBe(503);
  });

  it('marks 429 as retryable', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: { status: 429 },
    });

    expect(error.retryable).toBe(true);
  });

  it('marks 500 as retryable', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: { status: 500 },
    });

    expect(error.retryable).toBe(true);
  });

  it('marks 503 as retryable', () => {
    const error = new HeraldError({
      provider: 'gemini',
      cause: { status: 503 },
    });

    expect(error.retryable).toBe(true);
  });

  it('marks 401 as not retryable', () => {
    const error = new HeraldError({
      provider: 'anthropic',
      cause: { status: 401 },
    });

    expect(error.retryable).toBe(false);
  });

  it('marks 404 as not retryable', () => {
    const error = new HeraldError({
      provider: 'openai',
      cause: { status: 404 },
    });

    expect(error.retryable).toBe(false);
  });

  it('marks errors without a status code as not retryable', () => {
    const error = new HeraldError({
      provider: 'gemini',
      cause: new Error('network failure'),
    });

    expect(error.statusCode).toBeUndefined();
    expect(error.retryable).toBe(false);
  });
});
