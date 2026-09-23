import { describe, expect, it } from 'bun:test';

import { stringifyError } from './run-envelope';

describe('stringifyError with a tool-protocol ToolError', () => {
  // COR-1261 made ordinary tool failures settle a `ToolError` rather than the
  // raw thrown `Error`. A `ToolError` is a plain object, so `instanceof Error`
  // misses it and the JSON fallback turned a frame's human-facing `error`
  // string into a serialized object — observed downstream in bureau as
  // `{"code":"INTERNAL_ERROR",…,"message":"kaboom"}` where `kaboom` belonged.
  const toolError = {
    code: 'INTERNAL_ERROR',
    category: 'internal',
    retryable: false,
    message: 'kaboom',
  };

  it('returns the message, as it does for an Error', () => {
    expect(stringifyError(toolError)).toBe('kaboom');
    expect(stringifyError(new Error('kaboom'))).toBe('kaboom');
  });

  it('still serializes a plain object that is not a ToolError', () => {
    expect(stringifyError({ code: 'INTERNAL_ERROR', message: 'kaboom' })).toBe(
      '{"code":"INTERNAL_ERROR","message":"kaboom"}',
    );
  });
});
