import type {
  SkillCatalogEntry,
  SkillContent,
  SkillMetadata,
  SkillProvider,
  StorageAdapter,
} from './types';

const SKILL_PREFIX = 'skill:';
const METADATA_SUFFIX = ':metadata';
const BODY_SUFFIX = ':body';
const RESOURCE_SEGMENT = ':resource:';
const ENABLED_SUFFIX = ':enabled';

function metadataKey(name: string): string {
  return `${SKILL_PREFIX}${name}${METADATA_SUFFIX}`;
}

function bodyKey(name: string): string {
  return `${SKILL_PREFIX}${name}${BODY_SUFFIX}`;
}

function resourceKey(name: string, path: string): string {
  return `${SKILL_PREFIX}${name}${RESOURCE_SEGMENT}${path}`;
}

function resourcePrefix(name: string): string {
  return `${SKILL_PREFIX}${name}${RESOURCE_SEGMENT}`;
}

function enabledKey(name: string): string {
  return `${SKILL_PREFIX}${name}${ENABLED_SUFFIX}`;
}

function skillPrefix(name: string): string {
  return `${SKILL_PREFIX}${name}:`;
}

/**
 * Creates a skill provider backed by a key-value storage adapter.
 *
 * Uses the key namespace convention:
 * - `skill:{name}:metadata` — JSON-serialized SkillMetadata
 * - `skill:{name}:body` — the SKILL.md markdown body
 * - `skill:{name}:resource:{path}` — bundled resource content
 * - `skill:{name}:enabled` — "true" | "false"
 */
export function createStorageSkillProvider(adapter: StorageAdapter): SkillProvider {
  return {
    async listSkills(): Promise<SkillCatalogEntry[]> {
      const keys = await adapter.list(SKILL_PREFIX);
      const skillNames = new Set<string>();

      for (const key of keys) {
        // Extract skill name from keys matching skill:{name}:metadata
        if (key.endsWith(METADATA_SUFFIX)) {
          const withoutPrefix = key.slice(SKILL_PREFIX.length);
          const name = withoutPrefix.slice(0, -METADATA_SUFFIX.length);
          skillNames.add(name);
        }
      }

      const entries: SkillCatalogEntry[] = [];
      for (const name of skillNames) {
        const raw = await adapter.get(metadataKey(name));
        if (raw === null) continue;

        try {
          const metadata = JSON.parse(raw) as SkillMetadata;
          entries.push({ name: metadata.name, description: metadata.description });
        } catch {
          // Skip entries with corrupted metadata JSON.
        }
      }

      return entries;
    },

    async loadSkill(name: string): Promise<SkillContent | undefined> {
      const rawMetadata = await adapter.get(metadataKey(name));
      if (rawMetadata === null) return undefined;

      try {
        const metadata = JSON.parse(rawMetadata) as SkillMetadata;
        const body = (await adapter.get(bodyKey(name))) ?? '';
        return { metadata, body };
      } catch {
        return undefined;
      }
    },

    async saveSkill(name: string, content: SkillContent): Promise<void> {
      await adapter.set(metadataKey(name), JSON.stringify(content.metadata));
      await adapter.set(bodyKey(name), content.body);
    },

    async deleteSkill(name: string): Promise<void> {
      const keys = await adapter.list(skillPrefix(name));
      for (const key of keys) {
        await adapter.delete(key);
      }
    },

    async hasSkill(name: string): Promise<boolean> {
      const raw = await adapter.get(metadataKey(name));
      return raw !== null;
    },

    async listResources(name: string): Promise<string[]> {
      const prefix = resourcePrefix(name);
      const keys = await adapter.list(prefix);
      return keys.map((key) => key.slice(prefix.length));
    },

    async loadResource(name: string, path: string): Promise<string | undefined> {
      const raw = await adapter.get(resourceKey(name, path));
      return raw ?? undefined;
    },

    async saveResource(name: string, path: string, content: string): Promise<void> {
      await adapter.set(resourceKey(name, path), content);
    },

    async isEnabled(name: string): Promise<boolean> {
      const raw = await adapter.get(enabledKey(name));
      if (raw === null) return true;
      return raw !== 'false';
    },

    async setEnabled(name: string, enabled: boolean): Promise<void> {
      await adapter.set(enabledKey(name), String(enabled));
    },
  };
}
