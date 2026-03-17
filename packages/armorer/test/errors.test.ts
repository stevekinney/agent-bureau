import { describe, expect, it } from 'bun:test';

import { isToolError } from '../src/core';
import { errorString, normalizeError } from '../src/errors';

describe('errors', () => {
  it('normalizes Error with code/name and formats string', () => {
    const e = new Error('boom');
    e.name = 'E_BANG';
    const n = normalizeError(e);
    expect(n.code).toBe('E_BANG');
    expect(errorString(n)).toBe('E_BANG: boom');
  });

  it('normalizes non-Error values and handles cycles safely', () => {
    const a: any = { x: 1 };
    a.self = a; // circular to trigger stringify catch path
    const n = normalizeError(a);
    expect(typeof n.message).toBe('string');
  });

  it('normalizes string errors and formats without code', () => {
    const n = normalizeError('oops');
    expect(n.message).toBe('oops');
    expect(errorString(n)).toBe('oops');
  });

  it('normalizes plain object via JSON.stringify', () => {
    const n = normalizeError({ k: 1 });
    expect(n.message).toBe('{"k":1}');
  });

  it('detects valid ToolError shapes', () => {
    expect(
      isToolError({
        code: 'E_TOOL',
        category: 'internal',
        retryable: false,
        message: 'boom',
      }),
    ).toBe(true);
  });

  it('rejects invalid ToolError candidates', () => {
    expect(isToolError(null)).toBe(false);
    expect(isToolError('boom')).toBe(false);
    expect(
      isToolError({
        code: 'E_TOOL',
        category: 'internal',
        retryable: 'nope',
        message: 'boom',
      }),
    ).toBe(false);
  });
});
