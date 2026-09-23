import type { TextValueStore } from '@lostgradient/weft';

import { isValidSkillName, SkillParseError } from './parse-skill-markdown';
import type { SkillContent, SkillWriter } from './types';

/**
 * Resources cross a string-only key-value boundary, so bytes are base64-encoded on the way in.
 * Storing them as text instead would corrupt every binary asset, which is the defect this encoding
 * exists to prevent; base64 costs a third more storage and keeps the bytes exact.
 */
function encodeResourceBytes(content: Uint8Array): string {
  let binary = '';
  for (const byte of content) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

function enabledKey(name: string): string {
  return `${SKILL_PREFIX}${name}${ENABLED_SUFFIX}`;
}

function skillPrefix(name: string): string {
  return `${SKILL_PREFIX}${name}:`;
}

/**
 * Writes skills into a key-value store, under the key namespace discovery's `storage` source reads:
 *
 * - `skill:{name}:metadata` — JSON-serialized {@link SkillMetadata}
 * - `skill:{name}:body` — the `SKILL.md` markdown body
 * - `skill:{name}:resource:{path}` — one bundled resource, base64-encoded
 * - `skill:{name}:enabled` — `"true"` | `"false"`
 *
 * A write surface only. This used to read as well, which made it a second way to admit a skill
 * alongside discovery — and a skill admitted this way had no catalog entry, no trust decision, no
 * artifact digest and no compatibility verdict, so a run holding one could not say where it came
 * from. Reading is `readStoredSkillArtifacts` and the `storage` source now. What genuinely needs a
 * write path is the self-improvement flow persisting an accepted proposal, which is this.
 */
export function createStorageSkillProvider(adapter: TextValueStore): SkillWriter {
  return {
    async saveSkill(name: string, content: SkillContent): Promise<void> {
      if (!isValidSkillName(name)) {
        throw new SkillParseError(`Skill name "${name}" is not valid kebab-case.`);
      }
      if (content.metadata.name !== name) {
        throw new SkillParseError(
          `Skill name mismatch: parameter "${name}" does not match content metadata name "${content.metadata.name}".`,
        );
      }
      await adapter.set(metadataKey(name), JSON.stringify(content.metadata));
      await adapter.set(bodyKey(name), content.body);
    },

    async deleteSkill(name: string): Promise<void> {
      const keys = await adapter.list(skillPrefix(name));
      for (const key of keys) {
        await adapter.delete(key);
      }
    },

    async saveResource(name: string, path: string, content: Uint8Array): Promise<void> {
      if (!isValidSkillName(name)) {
        throw new SkillParseError(`Skill name "${name}" is not valid kebab-case.`);
      }
      await adapter.set(resourceKey(name, path), encodeResourceBytes(content));
    },

    async setEnabled(name: string, enabled: boolean): Promise<void> {
      await adapter.set(enabledKey(name), String(enabled));
    },
  };
}
