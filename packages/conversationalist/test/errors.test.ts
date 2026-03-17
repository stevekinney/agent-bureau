import { describe, expect, test } from 'bun:test';

import {
  ConversationalistError,
  createDuplicateIdError,
  createIntegrityError,
  createInvalidInputError,
  createInvalidPositionError,
  createInvalidToolReferenceError,
  createLockedError,
  createNotFoundError,
  createSerializationError,
  createValidationError,
} from '../src/errors';

describe('errors', () => {
  test('locked error', () => {
    const e = createLockedError('abc');
    expect(e).toBeInstanceOf(ConversationalistError);
    expect(e.code).toBe('error:locked');
    expect(e.toDetailedString()).toContain('locked');
  });

  test('invalid input', () => {
    const e = createInvalidInputError('bad', { foo: 1 });
    expect(e.code).toBe('error:invalid-input');
    expect(e.toDetailedString()).toContain('bad');
  });

  test('invalid position', () => {
    const e = createInvalidPositionError(1, 2);
    expect(e.code).toBe('error:invalid-position');
    expect(e.toDetailedString()).toContain('invalid position');
  });

  test('invalid tool reference', () => {
    const e = createInvalidToolReferenceError('missing');
    expect(e.code).toBe('error:invalid-tool-reference');
    expect(e.toDetailedString()).toContain('tool-use');
  });

  test('duplicate id', () => {
    const e = createDuplicateIdError('id1');
    expect(e.code).toBe('error:duplicate-id');
  });

  test('not found', () => {
    const e = createNotFoundError('id2');
    expect(e.code).toBe('error:not-found');
  });

  test('serialization', () => {
    const cause = new Error('cause');
    const e = createSerializationError('ser', cause);
    expect(e.code).toBe('error:serialization');
    expect(e.cause).toBe(cause);
  });

  test('validation', () => {
    const e = createValidationError('oops', { why: 'x' });
    expect(e.code).toBe('error:validation');
    expect(e.toDetailedString()).toContain('oops');
  });

  test('integrity', () => {
    const e = createIntegrityError('integrity failed', { issues: ['x'] });
    expect(e.code).toBe('error:integrity');
    expect(e.toDetailedString()).toContain('integrity failed');
  });
});
