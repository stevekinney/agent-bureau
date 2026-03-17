import { describe, expect, test } from 'bun:test';

describe('smoke', () => {
  test('basic', () => {
    expect(1 + 1).toBe(2);
  });
});
