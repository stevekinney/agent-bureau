import { MemoryStorage, textValueStore } from '@lostgradient/weft';

import type { SkillContent, SkillWriter } from '../types';

/**
 * Creates an in-memory text-value store for tests, backed by Weft's
 * {@link MemoryStorage}. Drop-in replacement for the prior storage-package mock:
 * same 7-method `TextValueStore` shape, prefix-inclusive `list`, synchronous
 * construction so call sites need no `await`.
 */
export function createMockKeyValueStore() {
  return textValueStore(new MemoryStorage());
}

/**
 * Creates an in-memory skill writer that tracks every call for assertion.
 *
 * Writes only, matching {@link SkillWriter}: a test that needs to read skills back discovers them,
 * the same way production does. `written` exposes what landed, so a test can assert the effect of a
 * write without a read method existing for production to reach for.
 */
export function createMockSkillProvider(initialSkills: SkillContent[] = []): SkillWriter & {
  calls: Array<{ method: string; args: unknown[] }>;
  written: ReadonlyMap<string, SkillContent>;
} {
  const skills = new Map<string, SkillContent>();
  const resources = new Map<string, Uint8Array>();
  const enabled = new Map<string, boolean>();
  const calls: Array<{ method: string; args: unknown[] }> = [];

  for (const skill of initialSkills) {
    skills.set(skill.metadata.name, skill);
  }

  return {
    calls,
    written: skills,

    async saveSkill(name: string, content: SkillContent): Promise<void> {
      calls.push({ method: 'saveSkill', args: [name, content] });
      skills.set(name, content);
    },

    async deleteSkill(name: string): Promise<void> {
      calls.push({ method: 'deleteSkill', args: [name] });
      skills.delete(name);
      // Remove associated resources
      for (const key of resources.keys()) {
        if (key.startsWith(`${name}:`)) {
          resources.delete(key);
        }
      }
      enabled.delete(name);
    },

    async saveResource(name: string, path: string, content: Uint8Array): Promise<void> {
      calls.push({ method: 'saveResource', args: [name, path, content] });
      resources.set(`${name}:${path}`, content);
    },

    async setEnabled(name: string, value: boolean): Promise<void> {
      calls.push({ method: 'setEnabled', args: [name, value] });
      enabled.set(name, value);
    },
  };
}
