import { describe, expect, it } from 'bun:test';

import { createStaticIdentityProvider } from '../../src/identity/create-static-provider';
import {
  acceptSoulUpdate,
  getSoulDiff,
  pinSoulItem,
  rejectSoulUpdate,
  unpinSoulItem,
} from '../../src/identity/soul-approval';
import type { SoulItem } from '../../src/identity/types';

function makeSoulItem(id: string, content: string, overrides?: Partial<SoulItem>): SoulItem {
  return {
    id,
    content,
    source: 'seed',
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    reinforcementCount: 0,
    ...overrides,
  };
}

describe('getSoulDiff', () => {
  it('returns empty diff when no pending update exists', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Be helpful.')],
    });

    const diff = await getSoulDiff(provider);
    expect(diff.empty).toBe(true);
    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.modifications).toEqual([]);
  });

  it('correctly identifies additions', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Existing item')],
    });

    await provider.savePendingSoulUpdate([
      makeSoulItem('1', 'Existing item'),
      makeSoulItem('2', 'New item'),
    ]);

    const diff = await getSoulDiff(provider);
    expect(diff.empty).toBe(false);
    expect(diff.additions).toHaveLength(1);
    expect(diff.additions[0]!.proposed!.id).toBe('2');
    expect(diff.additions[0]!.proposed!.content).toBe('New item');
  });

  it('correctly identifies removals', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Keep'), makeSoulItem('2', 'Remove')],
    });

    await provider.savePendingSoulUpdate([makeSoulItem('1', 'Keep')]);

    const diff = await getSoulDiff(provider);
    expect(diff.empty).toBe(false);
    expect(diff.removals).toHaveLength(1);
    expect(diff.removals[0]!.current!.id).toBe('2');
  });

  it('correctly identifies modifications', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Old content')],
    });

    await provider.savePendingSoulUpdate([makeSoulItem('1', 'Updated content')]);

    const diff = await getSoulDiff(provider);
    expect(diff.empty).toBe(false);
    expect(diff.modifications).toHaveLength(1);
    expect(diff.modifications[0]!.current!.content).toBe('Old content');
    expect(diff.modifications[0]!.proposed!.content).toBe('Updated content');
  });

  it('returns empty diff when pending matches current', async () => {
    const items = [makeSoulItem('1', 'Same')];
    const provider = createStaticIdentityProvider({ soul: items });
    await provider.savePendingSoulUpdate(items);

    const diff = await getSoulDiff(provider);
    expect(diff.empty).toBe(true);
  });
});

describe('acceptSoulUpdate', () => {
  it('promotes pending to current and archives previous version', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Version 1')],
    });

    await provider.savePendingSoulUpdate([
      makeSoulItem('1', 'Version 1'),
      makeSoulItem('2', 'New in V2'),
    ]);

    const result = await acceptSoulUpdate(provider);
    expect(result).toBeDefined();

    // Current soul should be the pending update
    const soul = await provider.loadSoul();
    expect(soul).toHaveLength(2);
    expect(soul[1]!.content).toBe('New in V2');

    // Pending should be cleared
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    // History should contain the previous version
    const history = await provider.loadSoulHistory();
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.items[0]!.content).toBe('Version 1');
  });

  it('increments the version number', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'V1')],
    });

    // First update
    await provider.savePendingSoulUpdate([makeSoulItem('1', 'V2')]);
    const result1 = await acceptSoulUpdate(provider);
    expect(result1?.version).toBeGreaterThan(0);

    // Second update
    await provider.savePendingSoulUpdate([makeSoulItem('1', 'V3')]);
    const result2 = await acceptSoulUpdate(provider);
    expect(result2!.version).toBeGreaterThan(result1!.version);
  });

  it('returns undefined when no pending update exists', async () => {
    const provider = createStaticIdentityProvider();
    const result = await acceptSoulUpdate(provider);
    expect(result).toBeUndefined();
  });
});

describe('rejectSoulUpdate', () => {
  it('clears pending without affecting current soul', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Current')],
    });

    await provider.savePendingSoulUpdate([makeSoulItem('1', 'Rejected change')]);
    await rejectSoulUpdate(provider);

    // Pending should be gone
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    // Current soul should be unchanged
    const soul = await provider.loadSoul();
    expect(soul[0]!.content).toBe('Current');
  });

  it('is a no-op when no pending update exists', async () => {
    const provider = createStaticIdentityProvider();
    await rejectSoulUpdate(provider); // Should not throw
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();
  });
});

describe('pinSoulItem / unpinSoulItem', () => {
  it('pinSoulItem sets pinned to true', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Unpinned', { pinned: false })],
    });

    const result = await pinSoulItem(provider, '1');
    expect(result).toBe(true);

    const soul = await provider.loadSoul();
    expect(soul[0]!.pinned).toBe(true);
  });

  it('unpinSoulItem sets pinned to false', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Pinned', { pinned: true })],
    });

    const result = await unpinSoulItem(provider, '1');
    expect(result).toBe(true);

    const soul = await provider.loadSoul();
    expect(soul[0]!.pinned).toBe(false);
  });

  it('returns false for non-existent item ID', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Exists')],
    });

    expect(await pinSoulItem(provider, 'nonexistent')).toBe(false);
    expect(await unpinSoulItem(provider, 'nonexistent')).toBe(false);
  });

  it('updates the updatedAt timestamp when pinning', async () => {
    const provider = createStaticIdentityProvider({
      soul: [makeSoulItem('1', 'Item', { updatedAt: '2020-01-01T00:00:00Z' })],
    });

    await pinSoulItem(provider, '1');

    const soul = await provider.loadSoul();
    expect(soul[0]!.updatedAt).not.toBe('2020-01-01T00:00:00Z');
    // Should be a recent timestamp
    const updated = new Date(soul[0]!.updatedAt);
    expect(updated.getTime()).toBeGreaterThan(Date.now() - 5000);
  });
});
