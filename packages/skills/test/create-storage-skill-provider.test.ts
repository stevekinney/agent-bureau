import { beforeEach, describe, expect, it } from 'bun:test';

import { createStorageSkillProvider } from '../src/create-storage-skill-provider';
import { createMockStorageAdapter } from '../src/test/index';
import type { SkillContent, SkillProvider } from '../src/types';

function makeSkillContent(name: string, description = `Description for ${name}`): SkillContent {
  return {
    metadata: { name, description },
    body: `## Instructions for ${name}\n\nDo something useful.`,
  };
}

describe('createStorageSkillProvider', () => {
  let adapter: ReturnType<typeof createMockStorageAdapter>;
  let provider: SkillProvider;

  beforeEach(() => {
    adapter = createMockStorageAdapter();
    provider = createStorageSkillProvider(adapter);
  });

  describe('saveSkill and loadSkill', () => {
    it('round-trips correctly', async () => {
      const content = makeSkillContent('code-review');
      await provider.saveSkill('code-review', content);
      const loaded = await provider.loadSkill('code-review');
      expect(loaded).toEqual(content);
    });

    it('preserves all metadata fields', async () => {
      const content: SkillContent = {
        metadata: {
          name: 'full-metadata',
          description: 'A skill with all metadata fields',
          license: 'MIT',
          compatibility: 'Requires filesystem access',
          toolPolicy: { allowList: ['read', 'grep'], denyList: ['bash'] },
          metadata: { author: 'test', version: '2.0' },
        },
        body: '## Full metadata skill',
      };
      await provider.saveSkill('full-metadata', content);
      const loaded = await provider.loadSkill('full-metadata');
      expect(loaded).toEqual(content);
    });
  });

  describe('listSkills', () => {
    it('returns all registered skills', async () => {
      await provider.saveSkill('alpha', makeSkillContent('alpha'));
      await provider.saveSkill('beta', makeSkillContent('beta'));
      await provider.saveSkill('gamma', makeSkillContent('gamma'));

      const skills = await provider.listSkills();
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('returns empty array when none exist', async () => {
      const skills = await provider.listSkills();
      expect(skills).toEqual([]);
    });

    it('includes name and description from metadata', async () => {
      await provider.saveSkill('test-skill', makeSkillContent('test-skill', 'Custom description'));
      const skills = await provider.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.name).toBe('test-skill');
      expect(skills[0]?.description).toBe('Custom description');
    });
  });

  describe('deleteSkill', () => {
    it('removes metadata, body, resources, and enabled flag', async () => {
      await provider.saveSkill('doomed', makeSkillContent('doomed'));
      await provider.saveResource('doomed', 'scripts/helper.py', 'print("help")');
      await provider.setEnabled('doomed', false);

      await provider.deleteSkill('doomed');

      expect(await provider.loadSkill('doomed')).toBeUndefined();
      expect(await provider.hasSkill('doomed')).toBe(false);
      expect(await provider.listResources('doomed')).toEqual([]);
      // Verify all keys removed from storage
      const remainingKeys = await adapter.list('skill:doomed:');
      expect(remainingKeys).toEqual([]);
    });
  });

  describe('hasSkill', () => {
    it('returns true for existing skills', async () => {
      await provider.saveSkill('exists', makeSkillContent('exists'));
      expect(await provider.hasSkill('exists')).toBe(true);
    });

    it('returns false for missing skills', async () => {
      expect(await provider.hasSkill('nonexistent')).toBe(false);
    });
  });

  describe('resources', () => {
    it('saves and loads resources', async () => {
      await provider.saveResource('my-skill', 'scripts/extract.py', 'print("extract")');
      const content = await provider.loadResource('my-skill', 'scripts/extract.py');
      expect(content).toBe('print("extract")');
    });

    it('lists resources for a skill', async () => {
      await provider.saveResource('my-skill', 'scripts/a.py', 'a');
      await provider.saveResource('my-skill', 'scripts/b.py', 'b');
      await provider.saveResource('my-skill', 'templates/c.md', 'c');

      const listed = await provider.listResources('my-skill');
      const resources = listed.sort();
      expect(resources).toEqual(['scripts/a.py', 'scripts/b.py', 'templates/c.md']);
    });

    it('returns empty array when no resources exist', async () => {
      const resources = await provider.listResources('no-resources');
      expect(resources).toEqual([]);
    });

    it('returns undefined for non-existent resource', async () => {
      const content = await provider.loadResource('my-skill', 'missing.txt');
      expect(content).toBeUndefined();
    });
  });

  describe('isEnabled', () => {
    it('defaults to true when not explicitly set', async () => {
      await provider.saveSkill('new-skill', makeSkillContent('new-skill'));
      expect(await provider.isEnabled('new-skill')).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('toggles the enabled flag', async () => {
      await provider.saveSkill('toggle-skill', makeSkillContent('toggle-skill'));

      await provider.setEnabled('toggle-skill', false);
      expect(await provider.isEnabled('toggle-skill')).toBe(false);

      await provider.setEnabled('toggle-skill', true);
      expect(await provider.isEnabled('toggle-skill')).toBe(true);
    });
  });

  describe('key namespace convention', () => {
    it('stores metadata under skill:{name}:metadata', async () => {
      await provider.saveSkill('ns-test', makeSkillContent('ns-test'));
      const raw = await adapter.get('skill:ns-test:metadata');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toEqual(makeSkillContent('ns-test').metadata);
    });

    it('stores body under skill:{name}:body', async () => {
      const content = makeSkillContent('ns-test');
      await provider.saveSkill('ns-test', content);
      const raw = await adapter.get('skill:ns-test:body');
      expect(raw).toBe(content.body);
    });

    it('stores resources under skill:{name}:resource:{path}', async () => {
      await provider.saveResource('ns-test', 'scripts/run.sh', '#!/bin/bash');
      const raw = await adapter.get('skill:ns-test:resource:scripts/run.sh');
      expect(raw).toBe('#!/bin/bash');
    });

    it('stores enabled flag under skill:{name}:enabled', async () => {
      await provider.setEnabled('ns-test', false);
      const raw = await adapter.get('skill:ns-test:enabled');
      expect(raw).toBe('false');
    });
  });

  describe('loadSkill', () => {
    it('returns undefined for non-existent skills', async () => {
      const result = await provider.loadSkill('ghost');
      expect(result).toBeUndefined();
    });
  });

  describe('multiple skills coexistence', () => {
    it('skills do not interfere with each other', async () => {
      const alpha = makeSkillContent('alpha', 'Alpha skill');
      const beta = makeSkillContent('beta', 'Beta skill');

      await provider.saveSkill('alpha', alpha);
      await provider.saveSkill('beta', beta);
      await provider.saveResource('alpha', 'data.json', '{"alpha": true}');
      await provider.saveResource('beta', 'data.json', '{"beta": true}');
      await provider.setEnabled('alpha', false);
      await provider.setEnabled('beta', true);

      // Verify isolation
      expect(await provider.loadSkill('alpha')).toEqual(alpha);
      expect(await provider.loadSkill('beta')).toEqual(beta);
      expect(await provider.loadResource('alpha', 'data.json')).toBe('{"alpha": true}');
      expect(await provider.loadResource('beta', 'data.json')).toBe('{"beta": true}');
      expect(await provider.isEnabled('alpha')).toBe(false);
      expect(await provider.isEnabled('beta')).toBe(true);

      // Deleting one does not affect the other
      await provider.deleteSkill('alpha');
      expect(await provider.hasSkill('alpha')).toBe(false);
      expect(await provider.hasSkill('beta')).toBe(true);
      expect(await provider.loadResource('beta', 'data.json')).toBe('{"beta": true}');
    });
  });
});
