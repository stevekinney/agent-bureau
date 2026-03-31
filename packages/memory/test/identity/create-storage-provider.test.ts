import { describe, expect, it } from 'bun:test';
import { createMockKeyValueStore } from 'storage/test';

import { createStorageIdentityProvider } from '../../src/identity/create-storage-provider';
import type { SoulItem } from '../../src/identity/types';

function makeSoulItem(id: string, content: string): SoulItem {
  return {
    id,
    content,
    source: 'seed',
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    reinforcementCount: 0,
  };
}

describe('createStorageIdentityProvider', () => {
  it('loads empty soul for unknown agent', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);
    const soul = await provider.loadSoul();
    expect(soul).toEqual([]);
  });

  it('soul items round-trip through JSON serialization', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    const items = [
      makeSoulItem('1', 'Be helpful.'),
      {
        ...makeSoulItem('2', 'Always cite sources.'),
        source: 'graduated' as const,
        sourceEntryIds: ['m1', 'm2'],
        topic: 'communication',
        pinned: true,
        reinforcementCount: 5,
      },
    ];

    await provider.saveSoul(items);
    const loaded = await provider.loadSoul();

    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.id).toBe('1');
    expect(loaded[1]!.source).toBe('graduated');
    expect(loaded[1]!.sourceEntryIds).toEqual(['m1', 'm2']);
    expect(loaded[1]!.pinned).toBe(true);
  });

  it('uses correct key namespace convention', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    await provider.saveSoul([makeSoulItem('1', 'Soul')]);
    expect(adapter.store.has('identity:soul:orchestrator')).toBe(true);

    await provider.saveSoul([makeSoulItem('2', 'Agent soul')], 'research');
    expect(adapter.store.has('identity:soul:research')).toBe(true);

    await provider.savePersona('code', { descriptor: { name: 'Forge', role: 'coder' } });
    expect(adapter.store.has('identity:persona:code')).toBe(true);

    await provider.saveUserContext('User context here');
    expect(adapter.store.has('identity:user-context')).toBe(true);

    await provider.savePendingSoulUpdate([makeSoulItem('3', 'Pending')]);
    expect(adapter.store.has('identity:pending:orchestrator')).toBe(true);
  });

  it('missing keys return appropriate defaults', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    expect(await provider.loadSoul()).toEqual([]);
    expect(await provider.loadPersona('nonexistent')).toBeUndefined();
    expect(await provider.loadUserContext()).toBeUndefined();
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();
    expect(await provider.loadSoulHistory()).toEqual([]);
  });

  it('treats invalid JSON as missing data instead of throwing', async () => {
    const adapter = createMockKeyValueStore();
    adapter.store.set('identity:soul:orchestrator', '{not-valid-json');
    const provider = createStorageIdentityProvider(adapter);

    expect(await provider.loadSoul()).toEqual([]);
  });

  it('listPersonas uses prefix to discover persona keys', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    await provider.savePersona('research', { descriptor: { name: 'Atlas', role: 'researcher' } });
    await provider.savePersona('code', { descriptor: { name: 'Forge', role: 'coder' } });
    await provider.savePersona('scheduler', { text: 'Be concise and timezone-aware.' });

    const personas = await provider.listPersonas();
    expect(personas).toHaveLength(3);
    expect(personas).toContain('research');
    expect(personas).toContain('code');
    expect(personas).toContain('scheduler');
  });

  it('listPersonas returns empty array when no persona keys exist', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);
    const personas = await provider.listPersonas();
    expect(personas).toEqual([]);
  });

  it('deletePersona removes the persona key from storage', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    await provider.savePersona('research', { descriptor: { name: 'Atlas', role: 'researcher' } });
    expect(adapter.store.has('identity:persona:research')).toBe(true);

    await provider.deletePersona('research');
    expect(adapter.store.has('identity:persona:research')).toBe(false);

    const personas = await provider.listPersonas();
    expect(personas).toEqual([]);
  });

  it('deletePersona on non-existent ID is a no-op', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);
    await provider.deletePersona('nonexistent');
    // Should not throw, store unchanged
    expect(adapter.store.size).toBe(0);
  });

  it('version history accumulates on each save', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    await provider.saveSoul([makeSoulItem('1', 'Version 1')]);
    // First save has no history (nothing to archive)
    expect(await provider.loadSoulHistory()).toEqual([]);

    await provider.saveSoul([makeSoulItem('2', 'Version 2')]);
    const history1 = await provider.loadSoulHistory();
    expect(history1).toHaveLength(1);
    expect(history1[0]!.version).toBe(1);
    expect(history1[0]!.items[0]!.content).toBe('Version 1');

    await provider.saveSoul([makeSoulItem('3', 'Version 3')]);
    const history2 = await provider.loadSoulHistory();
    expect(history2).toHaveLength(2);
    expect(history2[1]!.version).toBe(2);
    expect(history2[1]!.items[0]!.content).toBe('Version 2');
  });

  it('pending update lifecycle', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    const pending = [makeSoulItem('p1', 'Proposed update')];
    await provider.savePendingSoulUpdate(pending);

    const loaded = await provider.loadPendingSoulUpdate();
    expect(loaded).toHaveLength(1);
    expect(loaded![0]!.content).toBe('Proposed update');

    await provider.clearPendingSoulUpdate();
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();
  });

  it('user context CRUD', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    expect(await provider.loadUserContext()).toBeUndefined();

    await provider.saveUserContext('Steve, UTC timezone');
    expect(await provider.loadUserContext()).toBe('Steve, UTC timezone');
  });

  it('agent-specific souls are isolated', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    await provider.saveSoul([makeSoulItem('o1', 'Orchestrator')]);
    await provider.saveSoul([makeSoulItem('r1', 'Research')], 'research');

    const orchestratorSoul = await provider.loadSoul();
    expect(orchestratorSoul[0]!.content).toBe('Orchestrator');
    const researchSoul = await provider.loadSoul('research');
    expect(researchSoul[0]!.content).toBe('Research');
  });

  it('persona data round-trips through JSON', async () => {
    const adapter = createMockKeyValueStore();
    const provider = createStorageIdentityProvider(adapter);

    await provider.savePersona('research', {
      descriptor: {
        name: 'Atlas',
        role: 'researcher',
        expertise: 'web search',
        taskContext: 'information gathering',
        domain: 'knowledge',
      },
      text: 'Always cite your sources.',
    });

    const persona = await provider.loadPersona('research');
    expect(persona?.descriptor?.name).toBe('Atlas');
    expect(persona?.descriptor?.expertise).toBe('web search');
    expect(persona?.text).toBe('Always cite your sources.');
  });
});
