import { describe, expect, it } from 'bun:test';

import { createSkillToolbox, isSkillContent } from '../src/create-skill-tools';
import { createSkillSession } from '../src/skill-session';
import { createMockSkillProvider } from '../src/test/index';
import type { SkillContent } from '../src/types';

function makeSkill(name: string, description: string, body?: string): SkillContent {
  return {
    metadata: { name, description },
    body: body ?? `Instructions for ${name}`,
  };
}

describe('createSkillTools', () => {
  describe('activate_skill', () => {
    it('returns wrapped content with resources listed', async () => {
      const provider = createMockSkillProvider([
        makeSkill('code-review', 'Reviews code', 'Review all files carefully.'),
      ]);
      await provider.saveResource('code-review', 'checklist.md', '# Checklist');

      const session = createSkillSession();
      const toolbox = createSkillToolbox({ provider, session });

      const result = await toolbox.activateSkill.execute({ name: 'code-review' });

      expect(result).toContain('<skill_content name="code-review">');
      expect(result).toContain('Review all files carefully.');
      expect(result).toContain('<skill_resources>');
      expect(result).toContain('<file>checklist.md</file>');
      expect(result).toContain('</skill_content>');
      expect(session.isActive('code-review')).toBe(true);
    });

    it('returns alreadyActive when skill is already active', async () => {
      const provider = createMockSkillProvider([makeSkill('code-review', 'Reviews code')]);

      const session = createSkillSession();
      session.activate('code-review');

      const toolbox = createSkillToolbox({ provider, session });
      const result = await toolbox.activateSkill.execute({ name: 'code-review' });

      expect(result).toEqual({ alreadyActive: true, name: 'code-review' });
    });

    it('returns an error for a non-existent skill', async () => {
      const provider = createMockSkillProvider([]);
      const session = createSkillSession();
      const toolbox = createSkillToolbox({ provider, session });

      const result = await toolbox.activateSkill.execute({ name: 'nonexistent' });

      expect(result).toEqual({ error: 'Skill not found', name: 'nonexistent' });
      expect(session.isActive('nonexistent')).toBe(false);
    });

    it('omits skill_resources block when there are no resources', async () => {
      const provider = createMockSkillProvider([
        makeSkill('code-review', 'Reviews code', 'Review carefully.'),
      ]);

      const session = createSkillSession();
      const toolbox = createSkillToolbox({ provider, session });

      const result = await toolbox.activateSkill.execute({ name: 'code-review' });

      expect(result).toContain('<skill_content name="code-review">');
      expect(result).not.toContain('<skill_resources>');
    });
  });

  describe('load_skill_resource', () => {
    it('returns content for an active skill resource', async () => {
      const provider = createMockSkillProvider([makeSkill('code-review', 'Reviews code')]);
      await provider.saveResource('code-review', 'checklist.md', '# Review Checklist');

      const session = createSkillSession();
      session.activate('code-review');

      const toolbox = createSkillToolbox({ provider, session });
      const result = await toolbox.loadSkillResource.execute({
        skillName: 'code-review',
        path: 'checklist.md',
      });

      expect(result).toEqual({ content: '# Review Checklist' });
    });

    it('rejects loading a resource for an inactive skill', async () => {
      const provider = createMockSkillProvider([makeSkill('code-review', 'Reviews code')]);
      await provider.saveResource('code-review', 'checklist.md', '# Checklist');

      const session = createSkillSession();
      const toolbox = createSkillToolbox({ provider, session });

      const result = await toolbox.loadSkillResource.execute({
        skillName: 'code-review',
        path: 'checklist.md',
      });

      expect(result).toEqual({
        error: 'Skill is not active',
        skillName: 'code-review',
      });
    });

    it('returns an error for a missing resource', async () => {
      const provider = createMockSkillProvider([makeSkill('code-review', 'Reviews code')]);

      const session = createSkillSession();
      session.activate('code-review');

      const toolbox = createSkillToolbox({ provider, session });
      const result = await toolbox.loadSkillResource.execute({
        skillName: 'code-review',
        path: 'nonexistent.md',
      });

      expect(result).toEqual({
        error: 'Resource not found',
        skillName: 'code-review',
        path: 'nonexistent.md',
      });
    });
  });

  describe('deactivate_skill', () => {
    it('removes a skill from the active set', async () => {
      const provider = createMockSkillProvider([]);
      const session = createSkillSession();
      session.activate('code-review');

      const toolbox = createSkillToolbox({ provider, session });
      const result = await toolbox.deactivateSkill.execute({ name: 'code-review' });

      expect(result).toEqual({ deactivated: true, name: 'code-review' });
      expect(session.isActive('code-review')).toBe(false);
    });

    it('returns notActive when deactivating a non-active skill', async () => {
      const provider = createMockSkillProvider([]);
      const session = createSkillSession();

      const toolbox = createSkillToolbox({ provider, session });
      const result = await toolbox.deactivateSkill.execute({ name: 'nonexistent' });

      expect(result).toEqual({ deactivated: false, name: 'nonexistent' });
    });
  });

  describe('list_skills', () => {
    it('returns catalog entries with active status', async () => {
      const provider = createMockSkillProvider([
        makeSkill('code-review', 'Reviews code'),
        makeSkill('deploy', 'Deploys apps'),
      ]);

      const session = createSkillSession();
      session.activate('code-review');

      const toolbox = createSkillToolbox({ provider, session });
      const result = await toolbox.listSkills.execute({});

      expect(result).toEqual({
        skills: [
          { name: 'code-review', description: 'Reviews code', active: true },
          { name: 'deploy', description: 'Deploys apps', active: false },
        ],
      });
    });
  });

  describe('isSkillContent', () => {
    it('identifies skill content correctly', () => {
      expect(isSkillContent('<skill_content name="code-review">Instructions</skill_content>')).toBe(
        true,
      );
    });

    it('returns false for non-skill content', () => {
      expect(isSkillContent('Just a regular message')).toBe(false);
      expect(isSkillContent('<available_skills>catalog</available_skills>')).toBe(false);
    });
  });
});
