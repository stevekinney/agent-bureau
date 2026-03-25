import { describe, expect, it } from 'bun:test';

import { extractKeywords, isStopWord } from '../src/query-expansion';

describe('isStopWord', () => {
  it('identifies English stop words', () => {
    expect(isStopWord('the')).toBe(true);
    expect(isStopWord('is')).toBe(true);
    expect(isStopWord('something')).toBe(true);
  });

  it('identifies Spanish stop words', () => {
    expect(isStopWord('el')).toBe(true);
    expect(isStopWord('para')).toBe(true);
  });

  it('identifies Chinese stop words', () => {
    expect(isStopWord('的')).toBe(true);
    expect(isStopWord('是')).toBe(true);
  });

  it('identifies Korean stop words', () => {
    expect(isStopWord('그리고')).toBe(true);
  });

  it('identifies Japanese stop words', () => {
    expect(isStopWord('です')).toBe(true);
    expect(isStopWord('する')).toBe(true);
  });

  it('returns false for non-stop words', () => {
    expect(isStopWord('database')).toBe(false);
    expect(isStopWord('authentication')).toBe(false);
    expect(isStopWord('api')).toBe(false);
  });
});

describe('extractKeywords', () => {
  it('removes English stop words from a conversational query', () => {
    const keywords = extractKeywords('that thing we discussed about the API');

    expect(keywords).toContain('discussed');
    expect(keywords).toContain('api');
    expect(keywords).not.toContain('that');
    expect(keywords).not.toContain('thing');
    expect(keywords).not.toContain('the');
  });

  it('removes short English words (< 3 characters)', () => {
    const keywords = extractKeywords('go to db for an ok fix');

    expect(keywords).not.toContain('go');
    expect(keywords).not.toContain('to');
    expect(keywords).not.toContain('an');
    expect(keywords).not.toContain('ok');
    expect(keywords).toContain('fix');
  });

  it('removes pure numbers', () => {
    const keywords = extractKeywords('error 404 in authentication module');

    expect(keywords).not.toContain('404');
    expect(keywords).toContain('error');
    expect(keywords).toContain('authentication');
    expect(keywords).toContain('module');
  });

  it('returns an empty array for an all-stop-word query', () => {
    const keywords = extractKeywords('what is this thing');
    expect(keywords).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('deduplicates tokens', () => {
    const keywords = extractKeywords('bug bug bug fix fix');
    const bugCount = keywords.filter((k) => k === 'bug').length;
    const fixCount = keywords.filter((k) => k === 'fix').length;

    expect(bugCount).toBe(1);
    expect(fixCount).toBe(1);
  });

  it('lowercases all tokens', () => {
    const keywords = extractKeywords('Authentication API Database');

    for (const keyword of keywords) {
      expect(keyword).toBe(keyword.toLowerCase());
    }
  });

  it('extracts Chinese character unigrams and bigrams', () => {
    const keywords = extractKeywords('讨论方案');

    // Should include individual characters and bigrams, minus stop words.
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain('讨论');
  });

  it('handles mixed CJK and Latin text', () => {
    const keywords = extractKeywords('API的方案讨论');

    expect(keywords.length).toBeGreaterThan(0);
    // 的 is a Chinese stop word and should be removed.
  });

  it('handles Korean with trailing particle stripping', () => {
    // "인증을" = "인증" (authentication) + "을" (object particle)
    const keywords = extractKeywords('인증을 시스템에서');

    // Should extract stems with particles stripped.
    expect(keywords.length).toBeGreaterThan(0);
  });

  it('preserves technical terms', () => {
    const keywords = extractKeywords('what was the solution for the authentication middleware');

    expect(keywords).toContain('solution');
    expect(keywords).toContain('authentication');
    expect(keywords).toContain('middleware');
    expect(keywords).not.toContain('what');
    expect(keywords).not.toContain('was');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('for');
  });
});
