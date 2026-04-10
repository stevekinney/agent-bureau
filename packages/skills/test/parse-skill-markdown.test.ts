import { describe, expect, it } from 'bun:test';

import {
  isValidSkillName,
  parseSkillMarkdown,
  serializeSkillMarkdown,
  SkillParseError,
} from '../src/parse-skill-markdown';

describe('parseSkillMarkdown', () => {
  it('parses a valid SKILL.md with all fields', () => {
    const markdown = [
      '---',
      'name: code-review',
      'description: Use this skill when reviewing code for best practices.',
      'license: MIT',
      'compatibility: Requires filesystem access',
      'allowed-tools: Read, Grep, Glob',
      'metadata:',
      '  author: test-author',
      '  version: "1.0"',
      '---',
      '',
      '## Instructions',
      '',
      'Review the code carefully.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.name).toBe('code-review');
    expect(result.metadata.description).toBe(
      'Use this skill when reviewing code for best practices.',
    );
    expect(result.metadata.license).toBe('MIT');
    expect(result.metadata.compatibility).toBe('Requires filesystem access');
    expect(result.metadata.toolPolicy?.allowList).toEqual(['Read', 'Grep', 'Glob']);
    expect(result.metadata.metadata).toEqual({ author: 'test-author', version: '1.0' });
    expect(result.body).toBe('## Instructions\n\nReview the code carefully.');
  });

  it('parses a minimal SKILL.md with name and description only', () => {
    const markdown = [
      '---',
      'name: simple-skill',
      'description: A simple skill for testing.',
      '---',
      '',
      'Do the thing.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.name).toBe('simple-skill');
    expect(result.metadata.description).toBe('A simple skill for testing.');
    expect(result.metadata.license).toBeUndefined();
    expect(result.metadata.compatibility).toBeUndefined();
    expect(result.metadata.toolPolicy).toBeUndefined();
    expect(result.metadata.metadata).toBeUndefined();
    expect(result.body).toBe('Do the thing.');
  });

  it('throws SkillParseError when name is missing', () => {
    const markdown = [
      '---',
      'description: A skill without a name.',
      '---',
      '',
      'Body content.',
    ].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('throws SkillParseError when description is missing', () => {
    const markdown = ['---', 'name: no-description', '---', '', 'Body content.'].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('throws SkillParseError when name is empty', () => {
    const markdown = [
      '---',
      'name: ""',
      'description: Has a description.',
      '---',
      '',
      'Body content.',
    ].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('throws SkillParseError when description is empty', () => {
    const markdown = ['---', 'name: has-name', 'description: ""', '---', '', 'Body content.'].join(
      '\n',
    );

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('handles malformed YAML with unquoted colons in description', () => {
    const markdown = [
      '---',
      'name: colon-skill',
      'description: Use this skill when: reviewing code for problems.',
      '---',
      '',
      'Body content.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.name).toBe('colon-skill');
    expect(result.metadata.description).toContain('Use this skill when');
    expect(result.metadata.description).toContain('reviewing code for problems');
  });

  it('throws SkillParseError for completely invalid YAML', () => {
    const markdown = [
      '---',
      '{{{{not yaml at all!!!!',
      '  [ broken: {{ nope',
      '---',
      '',
      'Body content.',
    ].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('extracts and trims the body correctly', () => {
    const markdown = [
      '---',
      'name: body-test',
      'description: Test body extraction.',
      '---',
      '',
      '  ',
      '## Section One',
      '',
      'Content here.',
      '  ',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.body).toBe('## Section One\n\nContent here.');
  });

  it('parses allowed-tools into toolPolicy.allowList', () => {
    const markdown = [
      '---',
      'name: tool-policy-test',
      'description: Test tool policy parsing.',
      'allowed-tools: Read, Write, Bash, Edit',
      '---',
      '',
      'Instructions.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.toolPolicy).toBeDefined();
    expect(result.metadata.toolPolicy?.allowList).toEqual(['Read', 'Write', 'Bash', 'Edit']);
  });

  it('parses YAML tool arrays and drops blank or non-string entries', () => {
    const markdown = [
      '---',
      'name: array-tool-policy',
      'description: Tool arrays should be normalized.',
      'allowed-tools:',
      '  - Read',
      '  - " Write "',
      '  - ""',
      '  - 42',
      'denied-tools:',
      '  - Bash',
      '  - "  "',
      '  - Edit',
      '---',
      '',
      'Instructions.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.toolPolicy).toEqual({
      allowList: ['Read', 'Write'],
      denyList: ['Bash', 'Edit'],
    });
  });

  it('produces empty string for empty body', () => {
    const markdown = [
      '---',
      'name: empty-body',
      'description: Skill with no body content.',
      '---',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.body).toBe('');
  });

  it('produces empty string for frontmatter-only file with trailing newlines', () => {
    const markdown = [
      '---',
      'name: frontmatter-only',
      'description: Just frontmatter, nothing else.',
      '---',
      '',
      '',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.body).toBe('');
  });

  it('preserves metadata as Record<string, string>', () => {
    const markdown = [
      '---',
      'name: metadata-test',
      'description: Test metadata preservation.',
      'metadata:',
      '  author: Jane Doe',
      '  version: "2.0"',
      '  category: testing',
      '---',
      '',
      'Body.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.metadata).toEqual({
      author: 'Jane Doe',
      version: '2.0',
      category: 'testing',
    });
  });
});

describe('serializeSkillMarkdown', () => {
  it('round-trips with parseSkillMarkdown', () => {
    const original = [
      '---',
      'name: round-trip',
      'description: Test round-trip serialization.',
      'license: MIT',
      'compatibility: Requires filesystem access',
      'allowed-tools: Read, Grep',
      'metadata:',
      '  author: tester',
      '---',
      '',
      '## Instructions',
      '',
      'Do the thing.',
    ].join('\n');

    const parsed = parseSkillMarkdown(original);
    const serialized = serializeSkillMarkdown(parsed);
    const reparsed = parseSkillMarkdown(serialized);

    expect(reparsed.metadata.name).toBe(parsed.metadata.name);
    expect(reparsed.metadata.description).toBe(parsed.metadata.description);
    expect(reparsed.metadata.license).toBe(parsed.metadata.license);
    expect(reparsed.metadata.compatibility).toBe(parsed.metadata.compatibility);
    expect(reparsed.metadata.toolPolicy?.allowList).toEqual(parsed.metadata.toolPolicy?.allowList);
    expect(reparsed.metadata.metadata).toEqual(parsed.metadata.metadata);
    expect(reparsed.body).toBe(parsed.body);
  });

  it('serializes minimal content correctly', () => {
    const content = {
      metadata: {
        name: 'minimal',
        description: 'A minimal skill.',
      },
      body: 'Just a body.',
    };

    const serialized = serializeSkillMarkdown(content);
    const reparsed = parseSkillMarkdown(serialized);

    expect(reparsed.metadata.name).toBe('minimal');
    expect(reparsed.metadata.description).toBe('A minimal skill.');
    expect(reparsed.body).toBe('Just a body.');
  });

  it('maps toolPolicy.allowList back to allowed-tools', () => {
    const content = {
      metadata: {
        name: 'tool-serialize',
        description: 'Test tool serialization.',
        toolPolicy: { allowList: ['Read', 'Write'] },
      },
      body: '',
    };

    const serialized = serializeSkillMarkdown(content);

    expect(serialized).toContain('allowed-tools');
    expect(serialized).toContain('Read');
    expect(serialized).toContain('Write');

    const reparsed = parseSkillMarkdown(serialized);
    expect(reparsed.metadata.toolPolicy?.allowList).toEqual(['Read', 'Write']);
  });
});

describe('isValidSkillName', () => {
  it('accepts simple kebab-case names', () => {
    expect(isValidSkillName('code-review')).toBe(true);
    expect(isValidSkillName('deploy')).toBe(true);
    expect(isValidSkillName('my-skill-2')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('a1')).toBe(true);
  });

  it('rejects names starting with a digit', () => {
    expect(isValidSkillName('2fast')).toBe(false);
  });

  it('rejects names with uppercase letters', () => {
    expect(isValidSkillName('Code-Review')).toBe(false);
    expect(isValidSkillName('codeReview')).toBe(false);
  });

  it('rejects names with underscores', () => {
    expect(isValidSkillName('code_review')).toBe(false);
  });

  it('rejects names with leading or trailing hyphens', () => {
    expect(isValidSkillName('-leading')).toBe(false);
    expect(isValidSkillName('trailing-')).toBe(false);
  });

  it('rejects names with consecutive hyphens', () => {
    expect(isValidSkillName('code--review')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidSkillName('')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(isValidSkillName('code review')).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(isValidSkillName('code.review')).toBe(false);
    expect(isValidSkillName('code/review')).toBe(false);
    expect(isValidSkillName('code@review')).toBe(false);
  });
});

describe('parseSkillMarkdown name validation', () => {
  it('throws SkillParseError for non-kebab-case names', () => {
    const markdown = ['---', 'name: Code_Review', 'description: A skill.', '---', '', 'Body.'].join(
      '\n',
    );

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
    expect(() => parseSkillMarkdown(markdown)).toThrow(/not valid kebab-case/);
  });

  it('throws SkillParseError for names with uppercase', () => {
    const markdown = ['---', 'name: MySkill', 'description: A skill.', '---', '', 'Body.'].join(
      '\n',
    );

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });
});

describe('SkillParseError', () => {
  it('is an instance of Error', () => {
    const error = new SkillParseError('test message');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SkillParseError);
    expect(error.message).toBe('test message');
  });

  it('preserves a cause', () => {
    const cause = new Error('underlying issue');
    const error = new SkillParseError('parse failed', cause);
    expect(error.cause).toBe(cause);
  });
});
