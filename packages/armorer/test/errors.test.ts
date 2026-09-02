import { describe, expect, it } from 'bun:test';

import {
  isToolboxBudgetExceededToolError,
  isToolError,
  TOOLBOX_BUDGET_EXCEEDED_MARKER,
} from '../src/core';
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

describe('isToolboxBudgetExceededToolError (AB-231)', () => {
  it('accepts a ToolError carrying the toolbox budget-exceeded provenance marker', () => {
    const marked = {
      code: 'BUDGET_EXCEEDED',
      category: 'conflict',
      retryable: false,
      message: 'Budget exceeded: max calls 1',
      [TOOLBOX_BUDGET_EXCEEDED_MARKER]: true,
    };

    expect(isToolboxBudgetExceededToolError(marked)).toBe(true);
  });

  it('rejects a ToolError with a matching code but no provenance marker (a tool-defined BUDGET_EXCEEDED error)', () => {
    const unmarked = {
      code: 'BUDGET_EXCEEDED',
      category: 'conflict',
      retryable: false,
      message: 'This tool ran out of its own budget',
    };

    expect(isToolboxBudgetExceededToolError(unmarked)).toBe(false);
  });

  it('rejects a value that is not a ToolError at all', () => {
    expect(isToolboxBudgetExceededToolError(null)).toBe(false);
    expect(isToolboxBudgetExceededToolError('boom')).toBe(false);
    expect(isToolboxBudgetExceededToolError(new Error('boom'))).toBe(false);
  });
});
