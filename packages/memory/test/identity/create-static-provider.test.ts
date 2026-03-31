import { describe, expect, it } from 'bun:test';

import { createStaticIdentityProvider } from '../../src/identity/create-static-provider';
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

describe('createStaticIdentityProvider', () => {
  it('loads an empty soul when no initial data provided', async () => {
    const provider = createStaticIdentityProvider();
    const soul = await provider.loadSoul();
    expect(soul).toEqual([]);
  });

  it('loads initial soul items', async () => {
    const items = [makeSoulItem('1', 'Be helpful.')];
    const provider = createStaticIdentityProvider({ soul: items });
    const soul = await provider.loadSoul();
    expect(soul).toHaveLength(1);
    expect(soul[0]!.content).toBe('Be helpful.');
  });

  it('saveSoul overwrites the current soul', async () => {
    const provider = createStaticIdentityProvider({ soul: [makeSoulItem('1', 'Old')] });
    await provider.saveSoul([makeSoulItem('2', 'New')]);

    const soul = await provider.loadSoul();
    expect(soul).toHaveLength(1);
    expect(soul[0]!.content).toBe('New');
  });

  it('saveSoul archives the previous version in history', async () => {
    const provider = createStaticIdentityProvider({ soul: [makeSoulItem('1', 'V1')] });
    await provider.saveSoul([makeSoulItem('2', 'V2')]);

    const history = await provider.loadSoulHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.items[0]!.content).toBe('V1');
  });

  it('listPersonas returns empty when none registered', async () => {
    const provider = createStaticIdentityProvider();
    const personas = await provider.listPersonas();
    expect(personas).toEqual([]);
  });

  it('savePersona + listPersonas returns registered agent IDs', async () => {
    const provider = createStaticIdentityProvider();
    await provider.savePersona('research', { descriptor: { name: 'Atlas', role: 'researcher' } });
    await provider.savePersona('code', { descriptor: { name: 'Forge', role: 'coder' } });

    const personas = await provider.listPersonas();
    expect(personas).toContain('research');
    expect(personas).toContain('code');
    expect(personas).toHaveLength(2);
  });

  it('loadPersona returns undefined for non-existent persona', async () => {
    const provider = createStaticIdentityProvider();
    const persona = await provider.loadPersona('nonexistent');
    expect(persona).toBeUndefined();
  });

  it('loadPersona returns saved persona data', async () => {
    const provider = createStaticIdentityProvider();
    await provider.savePersona('research', {
      descriptor: { name: 'Atlas', role: 'researcher' },
      text: 'Always cite sources.',
    });

    const persona = await provider.loadPersona('research');
    expect(persona?.descriptor?.name).toBe('Atlas');
    expect(persona?.text).toBe('Always cite sources.');
  });

  it('deletePersona removes a persona', async () => {
    const provider = createStaticIdentityProvider();
    await provider.savePersona('research', { descriptor: { name: 'Atlas', role: 'researcher' } });
    await provider.deletePersona('research');

    const personas = await provider.listPersonas();
    expect(personas).toEqual([]);

    const persona = await provider.loadPersona('research');
    expect(persona).toBeUndefined();
  });

  it('deletePersona on non-existent ID is a no-op', async () => {
    const provider = createStaticIdentityProvider();
    // Should not throw
    await provider.deletePersona('nonexistent');
    const personas = await provider.listPersonas();
    expect(personas).toEqual([]);
  });

  it('user context CRUD', async () => {
    const provider = createStaticIdentityProvider();

    expect(await provider.loadUserContext()).toBeUndefined();

    await provider.saveUserContext('User prefers dark mode.');
    expect(await provider.loadUserContext()).toBe('User prefers dark mode.');

    await provider.saveUserContext('Updated context.');
    expect(await provider.loadUserContext()).toBe('Updated context.');
  });

  it('initializes user context from initial data', async () => {
    const provider = createStaticIdentityProvider({ userContext: 'Steve, UTC' });
    expect(await provider.loadUserContext()).toBe('Steve, UTC');
  });

  it('initializes the orchestrator persona from initial persona data', async () => {
    const provider = createStaticIdentityProvider({
      persona: { name: 'Atlas', role: 'researcher' },
      personaText: 'Always cite sources.',
    });

    const persona = await provider.loadPersona('orchestrator');

    expect(persona?.descriptor?.name).toBe('Atlas');
    expect(persona?.text).toBe('Always cite sources.');
  });

  it('pending update lifecycle: save, load, clear', async () => {
    const provider = createStaticIdentityProvider();

    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();

    const pending = [makeSoulItem('p1', 'Proposed change.')];
    await provider.savePendingSoulUpdate(pending);
    const loaded = await provider.loadPendingSoulUpdate();
    expect(loaded).toHaveLength(1);
    expect(loaded![0]!.content).toBe('Proposed change.');

    await provider.clearPendingSoulUpdate();
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();
  });

  it('supports agent-specific souls', async () => {
    const provider = createStaticIdentityProvider();
    await provider.saveSoul([makeSoulItem('o1', 'Orchestrator soul')]);
    await provider.saveSoul([makeSoulItem('r1', 'Research soul')], 'research');

    const orchestratorSoul = await provider.loadSoul();
    expect(orchestratorSoul[0]!.content).toBe('Orchestrator soul');
    const researchSoul = await provider.loadSoul('research');
    expect(researchSoul[0]!.content).toBe('Research soul');
  });

  it('default values for missing fields', async () => {
    const provider = createStaticIdentityProvider({});

    expect(await provider.loadSoul()).toEqual([]);
    expect(await provider.listPersonas()).toEqual([]);
    expect(await provider.loadUserContext()).toBeUndefined();
    expect(await provider.loadPendingSoulUpdate()).toBeUndefined();
    expect(await provider.loadSoulHistory()).toEqual([]);
  });
});
