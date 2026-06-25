import { describe, expect, it } from 'bun:test';

import { classifyError } from '../src/errors';

describe('classifyError', () => {
  it('ProviderError-like with retryable=true, statusCode=429 → rate-limit', () => {
    const error = Object.assign(new Error('rate limited'), {
      retryable: true,
      statusCode: 429,
      provider: 'openai',
    });

    const classified = classifyError(error);
    expect(classified.category).toBe('rate-limit');
    expect(classified.retryable).toBe(true);
    expect(classified.statusCode).toBe(429);
    expect(classified.provider).toBe('openai');
    expect(classified.original).toBe(error);
  });

  it('plain Error with statusCode=401 → authentication', () => {
    const error = Object.assign(new Error('unauthorized'), { statusCode: 401 });

    const classified = classifyError(error);
    expect(classified.category).toBe('authentication');
    expect(classified.retryable).toBe(false);
    expect(classified.statusCode).toBe(401);
  });

  it('plain Error with statusCode=403 → authentication', () => {
    const error = Object.assign(new Error('forbidden'), { statusCode: 403 });

    const classified = classifyError(error);
    expect(classified.category).toBe('authentication');
    expect(classified.retryable).toBe(false);
  });

  it('error with no status → unknown, retryable=false', () => {
    const error = new Error('something broke');

    const classified = classifyError(error);
    expect(classified.category).toBe('unknown');
    expect(classified.retryable).toBe(false);
    expect(classified.statusCode).toBeUndefined();
    expect(classified.provider).toBeUndefined();
  });

  it('error message containing ECONNREFUSED → network, retryable=true', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:3000');

    const classified = classifyError(error);
    expect(classified.category).toBe('network');
    expect(classified.retryable).toBe(true);
  });

  it('error message containing ETIMEDOUT → network, retryable=true', () => {
    const error = new Error('connect ETIMEDOUT 10.0.0.1:443');

    const classified = classifyError(error);
    expect(classified.category).toBe('network');
    expect(classified.retryable).toBe(true);
  });

  it('error message containing fetch failed → network, retryable=true', () => {
    const error = new TypeError('fetch failed');

    const classified = classifyError(error);
    expect(classified.category).toBe('network');
    expect(classified.retryable).toBe(true);
  });

  it('AbortError → timeout, retryable=false', () => {
    const error = new DOMException('The operation was aborted', 'AbortError');

    const classified = classifyError(error);
    expect(classified.category).toBe('timeout');
    expect(classified.retryable).toBe(false);
  });

  it('TimeoutError → timeout, retryable=false', () => {
    const error = new DOMException('The operation timed out', 'TimeoutError');

    const classified = classifyError(error);
    expect(classified.category).toBe('timeout');
    expect(classified.retryable).toBe(false);
  });

  it('status 503 → server, retryable=true', () => {
    const error = Object.assign(new Error('service unavailable'), { status: 503 });

    const classified = classifyError(error);
    expect(classified.category).toBe('server');
    expect(classified.retryable).toBe(true);
    expect(classified.statusCode).toBe(503);
  });

  it('status 400 → client, retryable=false', () => {
    const error = Object.assign(new Error('bad request'), { statusCode: 400 });

    const classified = classifyError(error);
    expect(classified.category).toBe('client');
    expect(classified.retryable).toBe(false);
  });

  it('retryable=false with statusCode overrides default retryability', () => {
    const error = Object.assign(new Error('rate limited but not retryable'), {
      retryable: false,
      statusCode: 429,
    });

    const classified = classifyError(error);
    expect(classified.category).toBe('rate-limit');
    expect(classified.retryable).toBe(false);
  });

  it('null error returns unknown', () => {
    const classified = classifyError(null);
    expect(classified.category).toBe('unknown');
    expect(classified.retryable).toBe(false);
    expect(classified.original).toBeNull();
  });

  it('undefined error returns unknown', () => {
    const classified = classifyError(undefined);
    expect(classified.category).toBe('unknown');
    expect(classified.retryable).toBe(false);
  });

  it('uses status when statusCode is absent', () => {
    const error = Object.assign(new Error('not found'), { status: 404 });

    const classified = classifyError(error);
    expect(classified.category).toBe('client');
    expect(classified.statusCode).toBe(404);
  });

  it('prefers statusCode over status', () => {
    const error = Object.assign(new Error('conflict'), { statusCode: 500, status: 409 });

    const classified = classifyError(error);
    expect(classified.statusCode).toBe(500);
    expect(classified.category).toBe('server');
  });
});
