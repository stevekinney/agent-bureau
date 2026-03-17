import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import { textMatches } from '../src/query-predicates';

describe('fuzzy text properties', () => {
  it('matches when similarity is at or above threshold', () => {
    const rng = createRng(42);
    const threshold = 0.7;
    for (let i = 0; i < 40; i += 1) {
      const base = randomString(rng, 8, 14);
      const maxDistance = Math.floor(base.length * (1 - threshold));
      const variant = mutateString(base, maxDistance, rng);
      const tool = makeTool(base);
      const predicate = textMatches({
        query: variant,
        mode: 'fuzzy',
        threshold,
      });
      expect(predicate(tool)).toBe(true);
    }
  });

  it('does not match when similarity is below threshold', () => {
    const rng = createRng(1337);
    const threshold = 0.7;
    for (let i = 0; i < 40; i += 1) {
      const base = randomString(rng, 8, 14);
      const maxDistance = Math.floor(base.length * (1 - threshold)) + 1;
      const variant = mutateString(base, maxDistance, rng);
      const tool = makeTool(base);
      const predicate = textMatches({
        query: variant,
        mode: 'fuzzy',
        threshold,
      });
      expect(predicate(tool)).toBe(false);
    }
  });

  it('is monotonic with respect to threshold', () => {
    const rng = createRng(9001);
    for (let i = 0; i < 40; i += 1) {
      const base = randomString(rng, 8, 14);
      const variant = mutateString(base, 2, rng);
      const tool = makeTool(base);
      const strict = textMatches({
        query: variant,
        mode: 'fuzzy',
        threshold: 0.85,
      })(tool);
      const lenient = textMatches({
        query: variant,
        mode: 'fuzzy',
        threshold: 0.5,
      })(tool);
      if (strict) {
        expect(lenient).toBe(true);
      }
    }
  });
});

function makeTool(name: string) {
  return createTool({
    name,
    description: `${name} tool`,
    input: z.object({}),
    execute: async () => null,
  });
}

function createRng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rng: () => number, min: number, max: number): string {
  const length = min + Math.floor(rng() * (max - min + 1));
  const chars = new Array<string>(length);
  for (let i = 0; i < length; i += 1) {
    const code = 97 + Math.floor(rng() * 26);
    chars[i] = String.fromCharCode(code);
  }
  return chars.join('');
}

function mutateString(value: string, edits: number, rng: () => number): string {
  if (!value) return value;
  const chars = value.split('');
  const indices = pickUniqueIndices(chars.length, edits, rng);
  for (const index of indices) {
    const original = chars[index] ?? 'a';
    let replacement = original;
    while (replacement === original) {
      const code = 97 + Math.floor(rng() * 26);
      replacement = String.fromCharCode(code);
    }
    chars[index] = replacement;
  }
  return chars.join('');
}

function pickUniqueIndices(length: number, count: number, rng: () => number): number[] {
  const result = new Set<number>();
  while (result.size < Math.min(count, length)) {
    result.add(Math.floor(rng() * length));
  }
  return Array.from(result);
}
