import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { loadDataset, loadDatasets } from './datasets';

const fixturesDirectory = join(import.meta.dir, '__test-fixtures__');

function fixturePath(name: string): string {
  return join(fixturesDirectory, name);
}

beforeEach(async () => {
  await Bun.write(
    fixturePath('valid-cases.json'),
    JSON.stringify([
      { name: 'case-1', input: 'What is 2+2?', tags: ['math'] },
      { name: 'case-2', input: 'Say hello' },
    ]),
  );

  await Bun.write(
    fixturePath('more-cases.json'),
    JSON.stringify([{ name: 'case-3', input: 'Summarize this text', tags: ['nlp'] }]),
  );

  await Bun.write(fixturePath('invalid.json'), '{ this is not valid json }');

  await Bun.write(
    fixturePath('missing-name.json'),
    JSON.stringify([{ input: 'no name provided' }]),
  );

  await Bun.write(
    fixturePath('missing-input.json'),
    JSON.stringify([{ name: 'has-name-but-no-input' }]),
  );

  await Bun.write(fixturePath('empty-array.json'), JSON.stringify([]));

  await Bun.write(
    fixturePath('with-optional-fields.json'),
    JSON.stringify([
      {
        name: 'full-case',
        input: 'test input',
        systemPrompt: 'You are helpful',
        expectedOutput: 'Hello!',
        expectedToolCalls: [{ name: 'search' }],
        maxSteps: 5,
        tags: ['full'],
        timeout: 10000,
      },
    ]),
  );

  await Bun.write(
    fixturePath('with-semantic-matcher.json'),
    JSON.stringify([
      {
        name: 'semantic-case',
        input: 'judge this',
        expectedOutput: {
          type: 'semantic',
          reference: 'ideal answer',
          threshold: 0.9,
        },
      },
    ]),
  );

  await Bun.write(fixturePath('invalid-entry-type.json'), JSON.stringify(['not-an-object']));

  await Bun.write(fixturePath('json-object.json'), JSON.stringify({ name: 'not-an-array' }));
});

afterEach(() => {
  try {
    rmSync(fixturesDirectory, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('loadDataset', () => {
  it('loads a valid JSON file into an array of EvaluationCase objects', async () => {
    const cases = await loadDataset(fixturePath('valid-cases.json'));

    expect(cases).toHaveLength(2);
    expect(cases[0]!.name).toBe('case-1');
    expect(cases[0]!.input).toBe('What is 2+2?');
    expect(cases[0]!.tags).toEqual(['math']);
    expect(cases[1]!.name).toBe('case-2');
    expect(cases[1]!.input).toBe('Say hello');
  });

  it('validates optional fields are preserved', async () => {
    const cases = await loadDataset(fixturePath('with-optional-fields.json'));

    expect(cases).toHaveLength(1);
    expect(cases[0]!.systemPrompt).toBe('You are helpful');
    expect(cases[0]!.expectedOutput).toBe('Hello!');
    expect(cases[0]!.expectedToolCalls).toEqual([{ name: 'search' }]);
    expect(cases[0]!.maxSteps).toBe(5);
    expect(cases[0]!.tags).toEqual(['full']);
    expect(cases[0]!.timeout).toBe(10000);
  });

  it('loads an empty array without error', async () => {
    const cases = await loadDataset(fixturePath('empty-array.json'));
    expect(cases).toHaveLength(0);
  });

  it('preserves semantic expectedOutput matchers from JSON datasets', async () => {
    const cases = await loadDataset(fixturePath('with-semantic-matcher.json'));

    expect(cases).toHaveLength(1);
    expect(cases[0]!.expectedOutput).toEqual({
      type: 'semantic',
      reference: 'ideal answer',
      threshold: 0.9,
    });
  });

  it('throws a descriptive error for invalid JSON', async () => {
    try {
      await loadDataset(fixturePath('invalid.json'));
      expect.unreachable('Expected loadDataset to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/invalid json/i);
    }
  });

  it('throws a descriptive error for missing files', async () => {
    try {
      await loadDataset(fixturePath('nonexistent.json'));
      expect.unreachable('Expected loadDataset to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/not found/i);
    }
  });

  it('throws a descriptive error when name is missing from a case', async () => {
    try {
      await loadDataset(fixturePath('missing-name.json'));
      expect.unreachable('Expected loadDataset to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/name/i);
    }
  });

  it('throws a descriptive error when input is missing from a case', async () => {
    try {
      await loadDataset(fixturePath('missing-input.json'));
      expect.unreachable('Expected loadDataset to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/input/i);
    }
  });

  it('throws when a dataset entry is not an object', async () => {
    try {
      await loadDataset(fixturePath('invalid-entry-type.json'));
      expect.unreachable('Expected loadDataset to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/not an object/i);
    }
  });

  it('throws when a dataset file contains a JSON object instead of an array', async () => {
    try {
      await loadDataset(fixturePath('json-object.json'));
      expect.unreachable('Expected loadDataset to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/json array/i);
    }
  });

  it('wraps filesystem read errors with the dataset path', async () => {
    const unreadablePath = fixturePath('unreadable.json');
    await Bun.write(unreadablePath, JSON.stringify([{ name: 'case', input: 'test' }]));
    await Bun.$`chmod 000 ${unreadablePath}`;

    try {
      await loadDataset(unreadablePath);
      expect.unreachable('Expected loadDataset to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/failed to read dataset file/i);
    } finally {
      await Bun.$`chmod 644 ${unreadablePath}`;
    }
  });
});

describe('loadDatasets', () => {
  it('loads multiple files matching a glob pattern', async () => {
    const cases = await loadDatasets(
      join(fixturesDirectory, '{valid-cases,more-cases,empty-array,with-optional-fields}.json'),
    );

    const names = cases.map((c) => c.name);
    expect(names).toContain('case-1');
    expect(names).toContain('case-2');
    expect(names).toContain('case-3');
    expect(names).toContain('full-case');
  });

  it('merges cases from all matching files into a single array', async () => {
    // Use a targeted glob to avoid invalid files
    const pattern = join(fixturesDirectory, '{valid-cases,more-cases}.json');
    const cases = await loadDatasets(pattern);

    expect(cases).toHaveLength(3);
    const names = cases.map((c) => c.name);
    expect(names).toContain('case-1');
    expect(names).toContain('case-2');
    expect(names).toContain('case-3');
  });

  it('returns an empty array when no files match the glob', async () => {
    const cases = await loadDatasets(join(fixturesDirectory, 'no-match-*.json'));
    expect(cases).toHaveLength(0);
  });

  it('propagates validation errors from individual files', async () => {
    try {
      await loadDatasets(join(fixturesDirectory, 'missing-name.json'));
      expect.unreachable('Expected loadDatasets to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/name/i);
    }
  });
});
