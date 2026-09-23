import { AbortAgentRunError } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';
import { serializeUnknownError } from './serialization';

describe('serializeUnknownError', () => {
  it('serializes circular objects without throwing', () => {
    const error: Record<string, unknown> = {};
    error['self'] = error;

    expect(serializeUnknownError(error)).toBe('{"self":"[Circular]"}');
  });

  it('serializes bigint-containing objects without throwing', () => {
    expect(serializeUnknownError({ value: 42n })).toBe('{"value":"42"}');
  });

  it('serializes repeated non-circular references without dropping later values', () => {
    const shared = { attempts: 2, ok: true };

    expect(serializeUnknownError({ first: shared, second: shared })).toBe(
      '{"first":{"attempts":2,"ok":true},"second":{"attempts":2,"ok":true}}',
    );
  });

  it('returns "null" for a null error', () => {
    expect(serializeUnknownError(null)).toBe('null');
  });

  it('returns "null" for an undefined error', () => {
    expect(serializeUnknownError(undefined)).toBe('null');
  });

  it('serializes symbols instead of returning undefined', () => {
    expect(serializeUnknownError(Symbol('boom'))).toBe('Symbol(boom)');
  });

  it('falls back to String when the host JSON serializer throws', () => {
    const stringify = spyOn(JSON, 'stringify').mockImplementationOnce(() => {
      throw new Error('serializer unavailable');
    });
    try {
      expect(serializeUnknownError(Symbol('boom'))).toBe('Symbol(boom)');
      expect(stringify).toHaveBeenCalledTimes(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it('serializes an object with a toJSON method by calling it instead of walking its own properties', () => {
    const value = {
      internal: 'should never be visible',
      toJSON(): unknown {
        return { summary: 'redacted view' };
      },
    };

    expect(serializeUnknownError(value)).toBe('{"summary":"redacted view"}');
  });

  it('preserves typed AgentRunError details', () => {
    const error = new AbortAgentRunError('cancelled', new Error('socket closed'));

    expect(JSON.parse(serializeUnknownError(error))).toMatchObject({
      name: 'AbortAgentRunError',
      message: 'cancelled',
      kind: 'abort',
      code: 'ABORTED',
      cause: {
        name: 'Error',
        message: 'socket closed',
      },
    });
  });
});
