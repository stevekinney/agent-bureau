import { describe, expect, it } from 'bun:test';

import { createSoulSeed } from '../../src/identity/create-seed';

describe('createSoulSeed', () => {
  it('produces a default seed with a single helpful-assistant item when no options given', () => {
    const items = createSoulSeed();

    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe('You are a helpful assistant.');
    expect(items[0]!.source).toBe('seed');
    expect(items[0]!.pinned).toBe(true);
    expect(items[0]!.reinforcementCount).toBe(0);
  });

  it('creates seed items from traits, values, and style', () => {
    const items = createSoulSeed({
      traits: ['Curious and thorough'],
      values: ['Always be honest'],
      style: ['Use concise language'],
    });

    expect(items).toHaveLength(3);

    const trait = items.find((i) => i.content === 'Curious and thorough');
    expect(trait).toBeDefined();
    expect(trait!.topic).toBe('trait');

    const value = items.find((i) => i.content === 'Always be honest');
    expect(value).toBeDefined();
    expect(value!.topic).toBe('value');

    const style = items.find((i) => i.content === 'Use concise language');
    expect(style).toBeDefined();
    expect(style!.topic).toBe('style');
  });

  it('all seed items have source "seed" and pinned true', () => {
    const items = createSoulSeed({
      name: 'Atlas',
      traits: ['Helpful', 'Precise'],
      values: ['Transparency'],
      style: ['Formal tone'],
      additional: 'Extra context here.',
    });

    for (const item of items) {
      expect(item.source).toBe('seed');
      expect(item.pinned).toBe(true);
      expect(item.reinforcementCount).toBe(0);
    }
  });

  it('includes name as an identity-topic item', () => {
    const items = createSoulSeed({ name: 'Atlas' });

    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe('Your name is Atlas.');
    expect(items[0]!.topic).toBe('identity');
  });

  it('includes additional content as an item', () => {
    const items = createSoulSeed({ additional: 'Some extra context.' });

    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe('Some extra context.');
  });

  it('empty arrays produce no items for that category', () => {
    const items = createSoulSeed({
      traits: [],
      values: [],
      style: [],
    });

    // All arrays empty, no name, no additional — falls back to default
    expect(items).toHaveLength(1);
    expect(items[0]!.content).toBe('You are a helpful assistant.');
  });

  it('produces unique IDs for each item', () => {
    const items = createSoulSeed({
      traits: ['A', 'B', 'C'],
      values: ['D', 'E'],
    });

    const ids = items.map((i) => i.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('each item has a valid ISO 8601 updatedAt timestamp', () => {
    const items = createSoulSeed({ traits: ['Test trait'] });

    for (const item of items) {
      const date = new Date(item.updatedAt);
      expect(date.toISOString()).toBe(item.updatedAt);
    }
  });
});
