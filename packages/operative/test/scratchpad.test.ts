import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  createScratchpad,
  createScratchpadReadTool,
  createScratchpadWriteTool,
  createTypedScratchpad,
} from '../src/create-scratchpad';

describe('createScratchpad', () => {
  describe('basic operations', () => {
    it('get/set/has for a key', () => {
      const pad = createScratchpad();
      pad.set('a', 1);
      expect(pad.has('a')).toBe(true);
      expect(pad.get('a')).toBe(1);
    });

    it('get returns undefined for missing key', () => {
      const pad = createScratchpad();
      expect(pad.get('missing')).toBeUndefined();
    });

    it('has returns false for missing key', () => {
      const pad = createScratchpad();
      expect(pad.has('missing')).toBe(false);
    });

    it('delete removes a key and returns true', () => {
      const pad = createScratchpad();
      pad.set('a', 1);
      expect(pad.delete('a')).toBe(true);
      expect(pad.has('a')).toBe(false);
    });

    it('delete returns false for missing key', () => {
      const pad = createScratchpad();
      expect(pad.delete('nope')).toBe(false);
    });

    it('keys returns all keys', () => {
      const pad = createScratchpad();
      pad.set('x', 1);
      pad.set('y', 2);
      expect([...pad.keys()]).toEqual(['x', 'y']);
    });

    it('entries returns all entries', () => {
      const pad = createScratchpad();
      pad.set('a', 10);
      pad.set('b', 20);
      expect([...pad.entries()]).toEqual([
        ['a', 10],
        ['b', 20],
      ]);
    });

    it('toJSON returns plain object', () => {
      const pad = createScratchpad();
      pad.set('a', 1);
      pad.set('b', 'hello');
      expect(pad.toJSON()).toEqual({ a: 1, b: 'hello' });
    });

    it('clear removes all entries', () => {
      const pad = createScratchpad();
      pad.set('a', 1);
      pad.set('b', 2);
      pad.clear();
      expect(pad.toJSON()).toEqual({});
    });
  });

  describe('initial values', () => {
    it('initializes with provided values', () => {
      const pad = createScratchpad({ initialValues: { x: 10, y: 'hello' } });
      expect(pad.get('x')).toBe(10);
      expect(pad.get('y')).toBe('hello');
      expect([...pad.keys()]).toEqual(['x', 'y']);
    });
  });

  describe('schema validation', () => {
    it('rejects a key not in the schema', () => {
      const pad = createScratchpad({
        schema: z.object({ name: z.string(), age: z.number() }),
      });
      expect(() => pad.set('invalid', 'value')).toThrow('Key "invalid" is not allowed');
    });

    it('rejects a value that does not match the schema', () => {
      const pad = createScratchpad({
        schema: z.object({ age: z.number() }),
      });
      expect(() => pad.set('age', 'not a number')).toThrow();
    });

    it('permits valid key and value', () => {
      const pad = createScratchpad({
        schema: z.object({ name: z.string() }),
      });
      pad.set('name', 'Alice');
      expect(pad.get('name')).toBe('Alice');
    });
  });

  describe('event emission', () => {
    it('emits entry.set with correct payload', () => {
      const pad = createScratchpad();
      const events: unknown[] = [];
      pad.addEventListener('entry.set', (event) => {
        events.push(event.detail);
      });

      pad.set('key', 'value');
      expect(events).toEqual([{ key: 'key', value: 'value', previousValue: undefined }]);
    });

    it('emits entry.set with previous value on overwrite', () => {
      const pad = createScratchpad();
      const events: unknown[] = [];
      pad.set('key', 'old');
      pad.addEventListener('entry.set', (event) => {
        events.push(event.detail);
      });

      pad.set('key', 'new');
      expect(events).toEqual([{ key: 'key', value: 'new', previousValue: 'old' }]);
    });

    it('emits entry.deleted with correct payload', () => {
      const pad = createScratchpad();
      pad.set('key', 42);
      const events: unknown[] = [];
      pad.addEventListener('entry.deleted', (event) => {
        events.push(event.detail);
      });

      pad.delete('key');
      expect(events).toEqual([{ key: 'key', previousValue: 42 }]);
    });

    it('does not emit entry.deleted for missing key', () => {
      const pad = createScratchpad();
      const events: unknown[] = [];
      pad.addEventListener('entry.deleted', (event) => {
        events.push(event.detail);
      });

      pad.delete('missing');
      expect(events).toHaveLength(0);
    });

    it('emits scratchpad.cleared with previous entries', () => {
      const pad = createScratchpad({ initialValues: { a: 1, b: 2 } });
      const events: unknown[] = [];
      pad.addEventListener('scratchpad.cleared', (event) => {
        events.push(event.detail);
      });

      pad.clear();
      expect(events).toEqual([{ previousEntries: { a: 1, b: 2 } }]);
    });
  });

  describe('concurrent async operations', () => {
    it('handles concurrent sets without data loss', async () => {
      const pad = createScratchpad();
      await Promise.all([
        Promise.resolve().then(() => pad.set('a', 1)),
        Promise.resolve().then(() => pad.set('b', 2)),
        Promise.resolve().then(() => pad.set('c', 3)),
      ]);
      expect(pad.toJSON()).toEqual({ a: 1, b: 2, c: 3 });
    });
  });
});

describe('scratchpad tools', () => {
  it('read tool reads a specific key', async () => {
    const pad = createScratchpad({ initialValues: { greeting: 'hello' } });
    const readTool = createScratchpadReadTool(pad);

    expect(readTool.name).toBe('read-scratchpad');
    const result = await readTool({ key: 'greeting' });
    expect(JSON.parse(result as string)).toEqual({
      found: true,
      key: 'greeting',
      value: 'hello',
    });
  });

  it('read tool returns not found for missing key', async () => {
    const pad = createScratchpad();
    const readTool = createScratchpadReadTool(pad);

    const result = await readTool({ key: 'missing' });
    expect(JSON.parse(result as string)).toEqual({ found: false, key: 'missing' });
  });

  it('read tool reads all entries when no key is provided', async () => {
    const pad = createScratchpad({ initialValues: { a: 1, b: 2 } });
    const readTool = createScratchpadReadTool(pad);

    const result = await readTool({});
    expect(JSON.parse(result as string)).toEqual({ a: 1, b: 2 });
  });

  it('write tool writes a value', async () => {
    const pad = createScratchpad();
    const writeTool = createScratchpadWriteTool(pad);

    expect(writeTool.name).toBe('write-scratchpad');
    await writeTool({ key: 'greeting', value: 'hello' });
    expect(pad.get('greeting')).toBe('hello');
  });

  it('tools work together for read-after-write', async () => {
    const pad = createScratchpad();
    const readTool = createScratchpadReadTool(pad);
    const writeTool = createScratchpadWriteTool(pad);

    await writeTool({ key: 'count', value: 42 });
    const result = await readTool({ key: 'count' });
    expect(JSON.parse(result as string)).toEqual({ found: true, key: 'count', value: 42 });
  });
});

describe('createTypedScratchpad', () => {
  interface TestSchema {
    name: string;
    count: number;
    active: boolean;
  }

  it('get/set with correct types at runtime', () => {
    const pad = createTypedScratchpad<TestSchema>();
    pad.set('name', 'Alice');
    pad.set('count', 42);
    pad.set('active', true);

    expect(pad.get('name')).toBe('Alice');
    expect(pad.get('count')).toBe(42);
    expect(pad.get('active')).toBe(true);
  });

  it('get returns undefined for unset key', () => {
    const pad = createTypedScratchpad<TestSchema>();
    expect(pad.get('name')).toBeUndefined();
  });

  it('preserves all other Scratchpad methods', () => {
    const pad = createTypedScratchpad<TestSchema>();
    pad.set('name', 'Bob');
    pad.set('count', 10);

    expect(pad.has('name')).toBe(true);
    expect(pad.has('count')).toBe(true);
    expect([...pad.keys()]).toEqual(['name', 'count']);
    expect([...pad.entries()]).toEqual([
      ['name', 'Bob'],
      ['count', 10],
    ]);
    expect(pad.toJSON()).toEqual({ name: 'Bob', count: 10 });

    expect(pad.delete('name')).toBe(true);
    expect(pad.has('name')).toBe(false);

    pad.clear();
    expect(pad.toJSON()).toEqual({});
  });

  it('works with schema validation', () => {
    const pad = createTypedScratchpad<{ age: number }>({
      schema: z.object({ age: z.number() }),
    });

    pad.set('age', 25);
    expect(pad.get('age')).toBe(25);

    expect(() =>
      (pad as never as { set(k: string, v: unknown): void }).set('age', 'not a number'),
    ).toThrow();
  });

  it('events fire correctly', () => {
    const pad = createTypedScratchpad<TestSchema>();
    const events: unknown[] = [];
    pad.addEventListener('entry.set', (event) => {
      events.push(event.detail);
    });

    pad.set('name', 'Charlie');
    expect(events).toEqual([{ key: 'name', value: 'Charlie', previousValue: undefined }]);
  });
});
