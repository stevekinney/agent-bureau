import { beforeEach, describe, expect, it } from 'bun:test';

import { createStaticSkillProvider } from '../src/create-static-skill-provider';
import type { SkillContent, SkillProvider } from '../src/types';

function makeSkillContent(name: string, description = `Description for ${name}`): SkillContent {
  return {
    metadata: { name, description },
    body: `## Instructions for ${name}\n\nDo something useful.`,
  };
}

describe('createStaticSkillProvider', () => {
  describe('with initial skills', () => {
    let provider: SkillProvider;
    const codeReview = makeSkillContent('code-review', 'Review code');
    const testing = makeSkillContent('testing', 'Write tests');

    beforeEach(() => {
      provider = createStaticSkillProvider([codeReview, testing]);
    });

    it('lists initial skills via listSkills', async () => {
      const skills = await provider.listSkills();
      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(['code-review', 'testing']);
    });

    it('loads initial skills via loadSkill', async () => {
      const loaded = await provider.loadSkill('code-review');
      expect(loaded).toEqual(codeReview);
    });

    it('reports initial skills via hasSkill', async () => {
      expect(await provider.hasSkill('code-review')).toBe(true);
      expect(await provider.hasSkill('nonexistent')).toBe(false);
    });
  });

  describe('saveSkill', () => {
    it('adds new skills', async () => {
      const provider = createStaticSkillProvider();
      const content = makeSkillContent('new-skill');

      await provider.saveSkill('new-skill', content);
      expect(await provider.hasSkill('new-skill')).toBe(true);
      expect(await provider.loadSkill('new-skill')).toEqual(content);

      const skills = await provider.listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0]?.name).toBe('new-skill');
    });
  });

  describe('deleteSkill', () => {
    it('removes skills', async () => {
      const provider = createStaticSkillProvider([makeSkillContent('doomed')]);

      await provider.deleteSkill('doomed');
      expect(await provider.hasSkill('doomed')).toBe(false);
      expect(await provider.loadSkill('doomed')).toBeUndefined();
      expect(await provider.listSkills()).toEqual([]);
    });

    it('removes associated resources and enabled state', async () => {
      const provider = createStaticSkillProvider([makeSkillContent('doomed')]);
      await provider.saveResource('doomed', 'data.json', '{}');
      await provider.setEnabled('doomed', false);

      await provider.deleteSkill('doomed');
      expect(await provider.listResources('doomed')).toEqual([]);
      // Enabled should revert to default (true) since state was removed
      expect(await provider.isEnabled('doomed')).toBe(true);
    });
  });

  describe('resource CRUD', () => {
    let provider: SkillProvider;

    beforeEach(() => {
      provider = createStaticSkillProvider();
    });

    it('saves and loads resources', async () => {
      await provider.saveResource('my-skill', 'scripts/run.sh', '#!/bin/bash');
      const content = await provider.loadResource('my-skill', 'scripts/run.sh');
      expect(content).toBe('#!/bin/bash');
    });

    it('lists resources for a skill', async () => {
      await provider.saveResource('my-skill', 'a.txt', 'a');
      await provider.saveResource('my-skill', 'b.txt', 'b');
      await provider.saveResource('other-skill', 'c.txt', 'c');

      const listed = await provider.listResources('my-skill');
      const resources = listed.sort();
      expect(resources).toEqual(['a.txt', 'b.txt']);
    });

    it('returns undefined for non-existent resource', async () => {
      expect(await provider.loadResource('my-skill', 'missing.txt')).toBeUndefined();
    });

    it('returns empty array when no resources exist', async () => {
      expect(await provider.listResources('no-resources')).toEqual([]);
    });
  });

  describe('enable/disable', () => {
    it('defaults to true', async () => {
      const provider = createStaticSkillProvider([makeSkillContent('test')]);
      expect(await provider.isEnabled('test')).toBe(true);
    });

    it('toggles enabled state', async () => {
      const provider = createStaticSkillProvider([makeSkillContent('test')]);

      await provider.setEnabled('test', false);
      expect(await provider.isEnabled('test')).toBe(false);

      await provider.setEnabled('test', true);
      expect(await provider.isEnabled('test')).toBe(true);
    });
  });

  describe('empty initialization', () => {
    it('produces empty list when no initial skills provided', async () => {
      const provider = createStaticSkillProvider();
      expect(await provider.listSkills()).toEqual([]);
    });

    it('produces empty list with explicit empty array', async () => {
      const provider = createStaticSkillProvider([]);
      expect(await provider.listSkills()).toEqual([]);
    });
  });
});
