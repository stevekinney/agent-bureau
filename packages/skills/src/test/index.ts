import type { SkillCatalogEntry, SkillContent, SkillProvider } from '../types';

/**
 * Creates a mock storage adapter backed by an in-memory Map.
 * Follows the same interface as IdentityStorageAdapter from memory.
 */
export function createMockStorageAdapter() {
  const store = new Map<string, string>();

  return {
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      return [...store.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

/**
 * Creates a mock skill provider that tracks all calls for assertion.
 * Useful for testing hooks and tools that depend on a SkillProvider.
 */
export function createMockSkillProvider(
  initialSkills: SkillContent[] = [],
): SkillProvider & { calls: Array<{ method: string; args: unknown[] }> } {
  const skills = new Map<string, SkillContent>();
  const resources = new Map<string, string>();
  const enabled = new Map<string, boolean>();
  const calls: Array<{ method: string; args: unknown[] }> = [];

  for (const skill of initialSkills) {
    skills.set(skill.metadata.name, skill);
  }

  return {
    calls,

    async listSkills(): Promise<SkillCatalogEntry[]> {
      calls.push({ method: 'listSkills', args: [] });
      return [...skills.values()].map((skill) => ({
        name: skill.metadata.name,
        description: skill.metadata.description,
      }));
    },

    async loadSkill(name: string): Promise<SkillContent | undefined> {
      calls.push({ method: 'loadSkill', args: [name] });
      return skills.get(name);
    },

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

    async listResources(name: string): Promise<string[]> {
      calls.push({ method: 'listResources', args: [name] });
      const prefix = `${name}:`;
      return [...resources.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },

    async loadResource(name: string, path: string): Promise<string | undefined> {
      calls.push({ method: 'loadResource', args: [name, path] });
      return resources.get(`${name}:${path}`);
    },

    async saveResource(name: string, path: string, content: string): Promise<void> {
      calls.push({ method: 'saveResource', args: [name, path, content] });
      resources.set(`${name}:${path}`, content);
    },

    async isEnabled(name: string): Promise<boolean> {
      calls.push({ method: 'isEnabled', args: [name] });
      return enabled.get(name) ?? true;
    },

    async setEnabled(name: string, value: boolean): Promise<void> {
      calls.push({ method: 'setEnabled', args: [name, value] });
      enabled.set(name, value);
    },
  };
}
