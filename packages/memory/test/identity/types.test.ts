import type { TextValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';

import type {
  AgentIdentity,
  IdentityProvider,
  PersonaDescriptor,
  SoulBudget,
  SoulItem,
} from '../../src/identity/types';

describe('Identity Types', () => {
  it('can create a SoulItem with all required fields', () => {
    const item: SoulItem = {
      id: 'soul-1',
      content: 'Be helpful and concise.',
      source: 'seed',
      pinned: true,
      updatedAt: '2026-01-01T00:00:00Z',
      reinforcementCount: 0,
    };

    expect(item.id).toBe('soul-1');
    expect(item.source).toBe('seed');
    expect(item.pinned).toBe(true);
    expect(item.reinforcementCount).toBe(0);
  });

  it('can create a SoulItem with optional fields', () => {
    const item: SoulItem = {
      id: 'soul-2',
      content: 'Prefer TypeScript for new projects.',
      source: 'graduated',
      sourceEntryIds: ['mem-1', 'mem-2'],
      pinned: false,
      topic: 'coding-preferences',
      updatedAt: '2026-03-15T12:00:00Z',
      reinforcementCount: 5,
    };

    expect(item.sourceEntryIds).toEqual(['mem-1', 'mem-2']);
    expect(item.topic).toBe('coding-preferences');
  });

  it('can create an AgentIdentity with soul only', () => {
    const identity: AgentIdentity = {
      soul: [
        {
          id: 'soul-1',
          content: 'You are a helpful assistant.',
          source: 'seed',
          pinned: true,
          updatedAt: '2026-01-01T00:00:00Z',
          reinforcementCount: 0,
        },
      ],
    };

    expect(identity.soul).toHaveLength(1);
    expect(identity.persona).toBeUndefined();
    expect(identity.personaText).toBeUndefined();
    expect(identity.userContext).toBeUndefined();
  });

  it('can create an AgentIdentity with all fields', () => {
    const identity: AgentIdentity = {
      soul: [],
      persona: { name: 'Atlas', role: 'Research Agent', expertise: 'web search' },
      personaText: 'Always cite your sources.',
      userContext: 'User prefers dark mode and UTC timezone.',
    };

    expect(identity.persona?.name).toBe('Atlas');
    expect(identity.personaText).toBe('Always cite your sources.');
    expect(identity.userContext).toBeDefined();
  });

  it('can create a PersonaDescriptor with required and optional fields', () => {
    const persona: PersonaDescriptor = {
      name: 'Code Agent',
      role: 'Code review and generation',
      expertise: 'TypeScript',
      taskContext: 'pull request review',
      domain: 'software engineering',
    };

    expect(persona.name).toBe('Code Agent');
    expect(persona.role).toBe('Code review and generation');
    expect(persona.expertise).toBe('TypeScript');
    expect(persona.taskContext).toBe('pull request review');
    expect(persona.domain).toBe('software engineering');
  });

  it('can create a PersonaDescriptor with required fields only', () => {
    const persona: PersonaDescriptor = {
      name: 'Scheduler',
      role: 'Meeting scheduling',
    };

    expect(persona.expertise).toBeUndefined();
    expect(persona.taskContext).toBeUndefined();
    expect(persona.domain).toBeUndefined();
  });

  it('SoulBudget has the expected shape', () => {
    const budget: SoulBudget = {
      maxTokens: 2000,
      estimateTokens: (text: string) => Math.ceil(text.length / 4),
      maxItemsPerTopic: 5,
    };

    expect(budget.maxTokens).toBe(2000);
    expect(budget.estimateTokens('hello world')).toBe(3);
    expect(budget.maxItemsPerTopic).toBe(5);
  });

  it('TextValueStore has the expected shape', () => {
    const adapter: TextValueStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      has: async () => false,
      deletePrefix: async () => 0,
      close: async () => {},
    };

    expect(typeof adapter.get).toBe('function');
    expect(typeof adapter.set).toBe('function');
    expect(typeof adapter.delete).toBe('function');
    expect(typeof adapter.list).toBe('function');
  });

  it('IdentityProvider has all required methods', () => {
    const provider: IdentityProvider = {
      loadSoul: async () => [],
      saveSoul: async () => {},
      listPersonas: async () => [],
      loadPersona: async () => undefined,
      savePersona: async () => {},
      deletePersona: async () => {},
      loadUserContext: async () => undefined,
      saveUserContext: async () => {},
      loadPendingSoulUpdate: async () => undefined,
      savePendingSoulUpdate: async () => {},
      clearPendingSoulUpdate: async () => {},
      loadSoulHistory: async () => [],
    };

    expect(typeof provider.loadSoul).toBe('function');
    expect(typeof provider.saveSoul).toBe('function');
    expect(typeof provider.listPersonas).toBe('function');
    expect(typeof provider.loadPersona).toBe('function');
    expect(typeof provider.savePersona).toBe('function');
    expect(typeof provider.deletePersona).toBe('function');
    expect(typeof provider.loadUserContext).toBe('function');
    expect(typeof provider.saveUserContext).toBe('function');
    expect(typeof provider.loadPendingSoulUpdate).toBe('function');
    expect(typeof provider.savePendingSoulUpdate).toBe('function');
    expect(typeof provider.clearPendingSoulUpdate).toBe('function');
    expect(typeof provider.loadSoulHistory).toBe('function');
  });
});
