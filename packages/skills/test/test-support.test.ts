import { describe, expect, it } from 'bun:test';

import { createMockSkillProvider } from '../src/test';
import type { SkillContent } from '../src/types';

function makeSkill(name: string, description = `Description for ${name}`): SkillContent {
  return {
    metadata: { name, description },
    body: `Instructions for ${name}`,
  };
}

describe('createMockSkillProvider', () => {
  it('saves skills and deletes their related resources and enabled state', async () => {
    const provider = createMockSkillProvider([makeSkill('keep-me')]);

    await provider.saveSkill('delete-me', makeSkill('delete-me'));
    await provider.saveResource('delete-me', 'guide.md', 'guide');
    await provider.saveResource('keep-me', 'guide.md', 'keep');
    await provider.setEnabled('delete-me', false);

    expect(await provider.loadSkill('delete-me')).toEqual(makeSkill('delete-me'));

    await provider.deleteSkill('delete-me');

    expect(await provider.loadSkill('delete-me')).toBeUndefined();
    expect(await provider.listResources('delete-me')).toEqual([]);
    expect(await provider.listResources('keep-me')).toEqual(['guide.md']);
    expect(await provider.isEnabled('delete-me')).toBe(true);
  });
});
