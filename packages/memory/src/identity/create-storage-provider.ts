import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import type { TextValueStore } from '@lostgradient/weft';

import type { IdentityProvider, PersonaDescriptor, SoulHistoryEntry, SoulItem } from './types';

const ORCHESTRATOR_KEY = 'orchestrator';

function soulKey(agentId?: string): string {
  return `identity:soul:${agentId ?? ORCHESTRATOR_KEY}`;
}

function personaKey(agentId: string): string {
  return `identity:persona:${agentId}`;
}

function pendingKey(agentId?: string): string {
  return `identity:pending:${agentId ?? ORCHESTRATOR_KEY}`;
}

function historyKey(agentId: string | undefined, version: number): string {
  return `identity:history:${agentId ?? ORCHESTRATOR_KEY}:${version}`;
}

const PERSONA_PREFIX = 'identity:persona:';
const HISTORY_PREFIX = 'identity:history:';
const USER_CONTEXT_KEY = 'identity:user-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSoulItem(value: unknown): value is SoulItem {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    typeof value['content'] === 'string' &&
    (value['source'] === 'seed' ||
      value['source'] === 'graduated' ||
      value['source'] === 'user-edit') &&
    typeof value['pinned'] === 'boolean' &&
    typeof value['updatedAt'] === 'string' &&
    typeof value['reinforcementCount'] === 'number'
  );
}

function isSoulItems(value: unknown): value is SoulItem[] {
  return Array.isArray(value) && value.every(isSoulItem);
}

function isPersona(value: unknown): value is { descriptor?: PersonaDescriptor; text?: string } {
  return (
    isRecord(value) &&
    (value['descriptor'] === undefined || isRecord(value['descriptor'])) &&
    (value['text'] === undefined || typeof value['text'] === 'string')
  );
}

function isSoulHistoryEntry(value: unknown): value is SoulHistoryEntry {
  return (
    isRecord(value) &&
    typeof value['version'] === 'number' &&
    typeof value['timestamp'] === 'string' &&
    isSoulItems(value['items'])
  );
}

/**
 * Creates an identity provider backed by a key-value storage adapter.
 *
 * Uses the key namespace convention:
 * - `identity:soul:{agentId}` — JSON-serialized SoulItem[]
 * - `identity:soul:orchestrator` — orchestrator soul (when no agentId)
 * - `identity:persona:{agentId}` — JSON-serialized persona
 * - `identity:user-context` — user context string
 * - `identity:pending:{agentId}` — pending soul update
 * - `identity:history:{agentId}:{version}` — soul version history
 */
export function createStorageIdentityProvider(
  adapter: TextValueStore,
  runtime: RuntimeServices = createDefaultRuntimeServices(),
): IdentityProvider {
  async function loadJson<T>(
    key: string,
    guard: (value: unknown) => value is T,
  ): Promise<T | undefined> {
    const raw = await adapter.get(key);
    if (raw === null) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      return guard(value) ? value : undefined;
    } catch {
      // If stored data is not valid JSON (e.g., from corruption or migration),
      // treat it as missing instead of throwing.
      return undefined;
    }
  }

  async function saveJson(key: string, value: unknown): Promise<void> {
    await adapter.set(key, JSON.stringify(value));
  }

  return {
    async loadSoul(agentId?: string): Promise<SoulItem[]> {
      return (await loadJson(soulKey(agentId), isSoulItems)) ?? [];
    },

    async saveSoul(items: SoulItem[], agentId?: string): Promise<void> {
      const key = soulKey(agentId);

      // Archive current soul in history before overwriting
      const current = await loadJson(key, isSoulItems);
      if (current && current.length > 0) {
        const agentKey = agentId ?? ORCHESTRATOR_KEY;
        const prefix = `${HISTORY_PREFIX}${agentKey}:`;
        const historyKeys = await adapter.list(prefix);
        const maxVersion = historyKeys.reduce((max, historyEntryKey) => {
          const versionString = historyEntryKey.slice(prefix.length);
          const version = parseInt(versionString, 10);
          return Number.isFinite(version) && version > max ? version : max;
        }, 0);
        const nextVersion = maxVersion + 1;
        const entry: SoulHistoryEntry = {
          version: nextVersion,
          items: current,
          timestamp: runtime.clock.nowISO(),
        };
        await saveJson(historyKey(agentId, nextVersion), entry);
      }

      await saveJson(key, items);
    },

    async listPersonas(): Promise<string[]> {
      const keys = await adapter.list(PERSONA_PREFIX);
      return keys.map((key) => key.slice(PERSONA_PREFIX.length));
    },

    async loadPersona(
      agentId: string,
    ): Promise<{ descriptor?: PersonaDescriptor; text?: string } | undefined> {
      return loadJson(personaKey(agentId), isPersona);
    },

    async savePersona(
      agentId: string,
      persona: { descriptor?: PersonaDescriptor; text?: string },
    ): Promise<void> {
      await saveJson(personaKey(agentId), persona);
    },

    async deletePersona(agentId: string): Promise<void> {
      await adapter.delete(personaKey(agentId));
    },

    async loadUserContext(): Promise<string | undefined> {
      const raw = await adapter.get(USER_CONTEXT_KEY);
      return raw ?? undefined;
    },

    async saveUserContext(context: string): Promise<void> {
      await adapter.set(USER_CONTEXT_KEY, context);
    },

    async loadPendingSoulUpdate(agentId?: string): Promise<SoulItem[] | undefined> {
      return loadJson(pendingKey(agentId), isSoulItems);
    },

    async savePendingSoulUpdate(items: SoulItem[], agentId?: string): Promise<void> {
      await saveJson(pendingKey(agentId), items);
    },

    async clearPendingSoulUpdate(agentId?: string): Promise<void> {
      await adapter.delete(pendingKey(agentId));
    },

    async loadSoulHistory(agentId?: string): Promise<SoulHistoryEntry[]> {
      const agentKey = agentId ?? ORCHESTRATOR_KEY;
      const keys = await adapter.list(`${HISTORY_PREFIX}${agentKey}:`);

      const entries: SoulHistoryEntry[] = [];
      for (const key of keys) {
        const entry = await loadJson(key, isSoulHistoryEntry);
        if (entry) entries.push(entry);
      }

      return entries.toSorted((a, b) => a.version - b.version);
    },
  };
}
