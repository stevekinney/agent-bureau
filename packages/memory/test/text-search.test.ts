import { describe, expect, it } from 'bun:test';

import { computeBM25Scores, tokenize } from '../src/text-search';

describe('tokenize', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes punctuation', () => {
    expect(tokenize('Hello, World! How are you?')).toEqual(['hello', 'world', 'how', 'are', 'you']);
  });

  it('handles empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles multiple spaces', () => {
    expect(tokenize('  hello   world  ')).toEqual(['hello', 'world']);
  });
});

describe('computeBM25Scores', () => {
  it('returns a positive score for a single matching term', () => {
    const scores = computeBM25Scores('cat', ['the cat sat on the mat']);
    expect(scores.get(0)).toBeGreaterThan(0);
  });

  it('returns score 0 when term is not in document', () => {
    const scores = computeBM25Scores('dog', ['the cat sat on the mat']);
    expect(scores.get(0)).toBe(0);
  });

  it('scores higher with more matching query terms', () => {
    const documents = ['the cat sat on the mat'];
    const singleTermScore = computeBM25Scores('cat', documents).get(0)!;
    const multiTermScore = computeBM25Scores('cat mat', documents).get(0)!;
    expect(multiTermScore).toBeGreaterThan(singleTermScore);
  });

  it('increases score with term frequency (with saturation)', () => {
    const documents = ['cat', 'cat cat cat'];
    const scores = computeBM25Scores('cat', documents);
    // doc with more "cat" occurrences scores higher
    expect(scores.get(1)!).toBeGreaterThan(scores.get(0)!);
  });

  it('normalizes by document length (shorter docs score higher for same term count)', () => {
    const documents = [
      'cat', // short doc, 1 term total
      'cat and some other words that make this document much longer than the first', // long doc, 1 "cat"
    ];
    const scores = computeBM25Scores('cat', documents);
    expect(scores.get(0)!).toBeGreaterThan(scores.get(1)!);
  });

  it('returns all scores 0 for an empty query', () => {
    const scores = computeBM25Scores('', ['hello world', 'foo bar']);
    expect(scores.get(0)).toBe(0);
    expect(scores.get(1)).toBe(0);
  });

  it('returns an empty map for empty documents', () => {
    const scores = computeBM25Scores('hello', []);
    expect(scores.size).toBe(0);
  });

  it('respects custom k1 and b parameters', () => {
    const documents = ['cat cat cat on the mat'];
    const defaultScores = computeBM25Scores('cat', documents);
    const customScores = computeBM25Scores('cat', documents, { k1: 2.0, b: 0.5 });
    // Different parameters should produce different scores
    expect(customScores.get(0)).not.toBe(defaultScores.get(0));
  });
});
