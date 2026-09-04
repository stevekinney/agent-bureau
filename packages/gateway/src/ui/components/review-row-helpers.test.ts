import { describe, expect, it } from 'bun:test';

import { formatAge, parseReviewPayload } from './review-row-helpers';

describe('formatAge', () => {
  it('renders "just now" for anything under one second', () => {
    expect(formatAge(0)).toBe('just now');
    expect(formatAge(999)).toBe('just now');
  });

  it('renders whole seconds under a minute', () => {
    expect(formatAge(1000)).toBe('1s');
    expect(formatAge(59_000)).toBe('59s');
  });

  it('renders whole minutes under an hour', () => {
    expect(formatAge(60_000)).toBe('1m');
    expect(formatAge(59 * 60_000)).toBe('59m');
  });

  it('renders whole hours under a day', () => {
    expect(formatAge(60 * 60_000)).toBe('1h');
    expect(formatAge(23 * 60 * 60_000)).toBe('23h');
  });

  it('renders whole days at and beyond 24 hours', () => {
    expect(formatAge(24 * 60 * 60_000)).toBe('1d');
    expect(formatAge(3 * 24 * 60 * 60_000)).toBe('3d');
  });
});

describe('parseReviewPayload', () => {
  it('returns undefined for a blank or whitespace-only textarea', () => {
    expect(parseReviewPayload('')).toBeUndefined();
    expect(parseReviewPayload('   \n\t')).toBeUndefined();
  });

  it('parses valid JSON', () => {
    expect(parseReviewPayload('{"name": "Ferris"}')).toEqual({ name: 'Ferris' });
    expect(parseReviewPayload('42')).toBe(42);
  });

  it('falls back to the trimmed plain text when the input is not valid JSON', () => {
    expect(parseReviewPayload('  Ferris  ')).toBe('Ferris');
  });
});
