import { describe, expect, it } from 'bun:test';

import { formatToolId, normalizeIdentity, parseToolId } from '../src/core';

describe('tool identity', () => {
  it('defaults namespace to "default"', () => {
    const identity = normalizeIdentity({ name: 'sum' });
    expect(identity.namespace).toBe('default');
  });

  it('formats and parses canonical ToolId strings', () => {
    const id = formatToolId({ namespace: 'default', name: 'sum', version: '1.0.0' });
    expect(id).toBe('default:sum@1.0.0');

    const parsed = parseToolId(id);
    expect(parsed).toEqual({ namespace: 'default', name: 'sum', version: '1.0.0' });
  });

  it('encodes and decodes namespace, name, and version components', () => {
    const identity = {
      namespace: 'team/tools',
      name: 'needs space',
      version: 'v1.0.0+exp',
    };

    const id = formatToolId(identity);
    expect(id).toBe('team%2Ftools:needs%20space@v1.0.0%2Bexp');

    const parsed = parseToolId(id);
    expect(parsed).toEqual(identity);
  });

  it('parses name-only ids into default namespace', () => {
    const parsed = parseToolId('search');
    expect(parsed).toEqual({ namespace: 'default', name: 'search' });
  });

  it('throws when parsing non-string ids', () => {
    expect(() => parseToolId(123 as unknown as string)).toThrow('ToolId must be a string');
  });

  it('throws when parsing empty ids', () => {
    expect(() => parseToolId('   ')).toThrow('ToolId must not be empty');
  });
});
