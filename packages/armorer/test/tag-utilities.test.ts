import { describe, expect, it } from 'bun:test';

import { assertKebabCaseTag, uniqTags } from '../src/tag-utilities';

describe('tag-utilities', () => {
  it('assertKebabCaseTag trims and returns valid kebab-case tags', () => {
    const value = assertKebabCaseTag('  hello-world  ', 'test');
    expect(value).toBe('hello-world');
  });

  it('throws if tag is not a string', () => {
    expect(() => assertKebabCaseTag(123 as unknown as string, 'test')).toThrow(
      /must be a string/,
    );
  });

  it('throws if tag is empty after trimming', () => {
    expect(() => assertKebabCaseTag('   ', 'test')).toThrow(/must not be empty/);
  });

  it('throws if tag is not kebab-case', () => {
    expect(() => assertKebabCaseTag('Not-Kebab', 'test')).toThrow(/kebab-case/);
  });

  it('deduplicates tags with uniqTags', () => {
    expect(uniqTags(['a', 'b', 'a', 'a'] as const)).toEqual(['a', 'b']);
  });
});
