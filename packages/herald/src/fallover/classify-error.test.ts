import { describe, expect, it } from 'bun:test';

import { HeraldError } from '../errors.ts';
import { classifyProviderError } from './classify-error.ts';

describe('classifyProviderError', () => {
  describe('auth errors', () => {
    it('classifies HeraldError with status 401 as auth', () => {
      const error = new HeraldError({
        provider: 'anthropic',
        cause: new Error('Unauthorized'),
        statusCode: 401,
      });
      expect(classifyProviderError(error)).toBe('auth');
    });

    it('classifies HeraldError with status 403 as auth', () => {
      const error = new HeraldError({
        provider: 'openai',
        cause: new Error('Forbidden'),
        statusCode: 403,
      });
      expect(classifyProviderError(error)).toBe('auth');
    });
  });

  describe('rate-limit errors', () => {
    it('classifies HeraldError with status 429 as rate-limit', () => {
      const error = new HeraldError({
        provider: 'anthropic',
        cause: new Error('Rate limited'),
        statusCode: 429,
      });
      expect(classifyProviderError(error)).toBe('rate-limit');
    });
  });

  describe('server errors', () => {
    it('classifies HeraldError with status 500 as server-error', () => {
      const error = new HeraldError({
        provider: 'openai',
        cause: new Error('Internal'),
        statusCode: 500,
      });
      expect(classifyProviderError(error)).toBe('server-error');
    });

    it('classifies HeraldError with status 502 as server-error', () => {
      const error = new HeraldError({
        provider: 'openai',
        cause: new Error('Bad Gateway'),
        statusCode: 502,
      });
      expect(classifyProviderError(error)).toBe('server-error');
    });

    it('classifies HeraldError with status 503 as server-error', () => {
      const error = new HeraldError({
        provider: 'anthropic',
        cause: new Error('Service Unavailable'),
        statusCode: 503,
      });
      expect(classifyProviderError(error)).toBe('server-error');
    });

    it('classifies HeraldError with status 504 as server-error', () => {
      const error = new HeraldError({
        provider: 'gemini',
        cause: new Error('Gateway Timeout'),
        statusCode: 504,
      });
      expect(classifyProviderError(error)).toBe('server-error');
    });
  });

  describe('overflow errors', () => {
    it('classifies error with context_length_exceeded message as overflow', () => {
      const error = new Error('context_length_exceeded: too many tokens');
      expect(classifyProviderError(error)).toBe('overflow');
    });

    it('classifies error with max_tokens message as overflow', () => {
      const error = new Error('max_tokens limit reached');
      expect(classifyProviderError(error)).toBe('overflow');
    });

    it('classifies HeraldError whose cause has overflow message as overflow', () => {
      const cause = new Error('This model has a context_length_exceeded error');
      const error = new HeraldError({ provider: 'anthropic', cause, statusCode: 400 });
      expect(classifyProviderError(error)).toBe('overflow');
    });
  });

  describe('network errors', () => {
    it('classifies error with ECONNREFUSED as network', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
      expect(classifyProviderError(error)).toBe('network');
    });

    it('classifies error with ETIMEDOUT as network', () => {
      const error = new Error('connect ETIMEDOUT 10.0.0.1:443');
      expect(classifyProviderError(error)).toBe('network');
    });

    it('classifies error with "fetch failed" as network', () => {
      const error = new TypeError('fetch failed');
      expect(classifyProviderError(error)).toBe('network');
    });
  });

  describe('unknown errors', () => {
    it('classifies a plain Error with no matching pattern as unknown', () => {
      const error = new Error('Something unexpected happened');
      expect(classifyProviderError(error)).toBe('unknown');
    });

    it('classifies a non-Error value as unknown', () => {
      expect(classifyProviderError('string error')).toBe('unknown');
      expect(classifyProviderError(42)).toBe('unknown');
      expect(classifyProviderError(null)).toBe('unknown');
      expect(classifyProviderError(undefined)).toBe('unknown');
    });

    it('classifies a custom object with status property as unknown when status does not match', () => {
      const error = { status: 418, message: 'I am a teapot' };
      expect(classifyProviderError(error)).toBe('unknown');
    });
  });

  describe('objects with status property', () => {
    it('classifies object with status 401 as auth', () => {
      const error = { status: 401, message: 'Unauthorized' };
      expect(classifyProviderError(error)).toBe('auth');
    });

    it('classifies object with status 429 as rate-limit', () => {
      const error = { status: 429, message: 'Too Many Requests' };
      expect(classifyProviderError(error)).toBe('rate-limit');
    });

    it('classifies object with status 503 as server-error', () => {
      const error = { status: 503, message: 'Service Unavailable' };
      expect(classifyProviderError(error)).toBe('server-error');
    });
  });
});
