import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';

import type {
  AgentIdentity,
  IdentityProvider,
  PersonaDescriptor,
  SoulHistoryEntry,
  SoulItem,
} from './types';

function initializeIdentity(
  initial: Partial<AgentIdentity> | undefined,
  souls: Map<string, SoulItem[]>,
  personas: Map<string, { descriptor?: PersonaDescriptor; text?: string }>,
): string | undefined {
  if (initial?.soul?.length) souls.set('orchestrator', [...initial.soul]);
  initializePersona(initial, personas);
  return initial?.userContext;
}

function initializePersona(
  initial: Partial<AgentIdentity> | undefined,
  personas: Map<string, { descriptor?: PersonaDescriptor; text?: string }>,
): void {
  if (!initial?.persona && !initial?.personaText) return;
  personas.set('orchestrator', {
    ...(initial.persona !== undefined ? { descriptor: initial.persona } : {}),
    ...(initial.personaText !== undefined ? { text: initial.personaText } : {}),
  });
}

/**
 * Creates an in-memory identity provider.
 *
 * Holds identity state in memory. Supports all mutations (saveSoul,
 * savePersona, etc.) that update in-memory state. Useful for testing
 * and for programmatic configuration where identity is constructed in code.
 */
export function createStaticIdentityProvider(
  initial?: Partial<AgentIdentity>,
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): IdentityProvider {
  const souls = new Map<string, SoulItem[]>();
  const personas = new Map<string, { descriptor?: PersonaDescriptor; text?: string }>();
  const pendingUpdates = new Map<string, SoulItem[]>();
  const history = new Map<string, SoulHistoryEntry[]>();
  let userContext: string | undefined;

  const orchestratorKey = 'orchestrator';

  userContext = initializeIdentity(initial, souls, personas);

  function resolveKey(agentId?: string): string {
    return agentId ?? orchestratorKey;
  }

  return {
    loadSoul(agentId?: string): Promise<SoulItem[]> {
      return Promise.resolve(souls.get(resolveKey(agentId)) ?? []);
    },

    saveSoul(items: SoulItem[], agentId?: string): Promise<void> {
      const key = resolveKey(agentId);

      // Archive current soul in history before overwriting
      const current = souls.get(key);
      if (current && current.length > 0) {
        const entries = history.get(key) ?? [];
        const nextVersion = entries.length + 1;
        entries.push({
          version: nextVersion,
          items: [...current],
          timestamp: runtime.clock.nowISO(),
        });
        history.set(key, entries);
      }

      souls.set(key, [...items]);
      return Promise.resolve();
    },

    listPersonas(): Promise<string[]> {
      return Promise.resolve([...personas.keys()].filter((key) => key !== orchestratorKey));
    },

    loadPersona(
      agentId: string,
    ): Promise<{ descriptor?: PersonaDescriptor; text?: string } | undefined> {
      return Promise.resolve(personas.get(agentId));
    },

    savePersona(
      agentId: string,
      persona: { descriptor?: PersonaDescriptor; text?: string },
    ): Promise<void> {
      personas.set(agentId, { ...persona });
      return Promise.resolve();
    },

    deletePersona(agentId: string): Promise<void> {
      personas.delete(agentId);
      return Promise.resolve();
    },

    loadUserContext(): Promise<string | undefined> {
      return Promise.resolve(userContext);
    },

    saveUserContext(context: string): Promise<void> {
      userContext = context;
      return Promise.resolve();
    },

    loadPendingSoulUpdate(agentId?: string): Promise<SoulItem[] | undefined> {
      return Promise.resolve(pendingUpdates.get(resolveKey(agentId)));
    },

    savePendingSoulUpdate(items: SoulItem[], agentId?: string): Promise<void> {
      pendingUpdates.set(resolveKey(agentId), [...items]);
      return Promise.resolve();
    },

    clearPendingSoulUpdate(agentId?: string): Promise<void> {
      pendingUpdates.delete(resolveKey(agentId));
      return Promise.resolve();
    },

    loadSoulHistory(agentId?: string): Promise<SoulHistoryEntry[]> {
      return Promise.resolve(history.get(resolveKey(agentId)) ?? []);
    },
  };
}
