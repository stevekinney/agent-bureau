import { describe, expect, it } from 'bun:test';

import { matchRoute } from './router';

describe('matchRoute', () => {
  it('matches /dashboard', () => {
    const result = matchRoute('/dashboard');
    expect(result).toEqual({ name: 'dashboard', params: {} });
  });

  it('matches /runs/:id', () => {
    const result = matchRoute('/runs/run-42');
    expect(result).toEqual({ name: 'run-detail', params: { id: 'run-42' } });
  });

  it('matches /configuration', () => {
    const result = matchRoute('/configuration');
    expect(result).toEqual({ name: 'configuration', params: {} });
  });

  it('matches /chat', () => {
    const result = matchRoute('/chat');
    expect(result).toEqual({ name: 'chat', params: {} });
  });

  it('returns undefined for unknown paths', () => {
    expect(matchRoute('/unknown')).toBeUndefined();
  });

  it('returns undefined for partial matches', () => {
    expect(matchRoute('/runs')).toBeUndefined();
    expect(matchRoute('/runs/a/b')).toBeUndefined();
  });

  it('handles trailing slashes', () => {
    const result = matchRoute('/dashboard/');
    expect(result).toEqual({ name: 'dashboard', params: {} });
  });
});
