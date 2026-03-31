import { describe, expect, it } from 'bun:test';

import { createSkillCatalogHook, escapeXml } from '../src/create-skill-catalog-hook';
import { createMockSkillProvider } from '../src/test/index';
import type { SkillContent } from '../src/types';

function makeSkill(name: string, description: string): SkillContent {
  return {
    metadata: { name, description },
    body: `Instructions for ${name}`,
  };
}

function makeContext(step: number) {
  return {
    step,
    conversation: {
      getMessages() {
        return [];
      },
    },
  };
}

describe('createSkillCatalogHook', () => {
  it('returns catalog XML on step 0', async () => {
    const provider = createMockSkillProvider([
      makeSkill('code-review', 'Reviews code for quality'),
      makeSkill('deploy', 'Deploys applications'),
    ]);

    const hook = createSkillCatalogHook({ provider });
    const result = await hook.prepareStep(makeContext(0));

    expect(result).toBeDefined();
    expect(result).toContain('<available_skills>');
    expect(result).toContain('</available_skills>');
    expect(result).toContain('<skill name="code-review">');
    expect(result).toContain('<skill name="deploy">');
  });

  it('returns undefined on step > 0', async () => {
    const provider = createMockSkillProvider([
      makeSkill('code-review', 'Reviews code for quality'),
    ]);

    const hook = createSkillCatalogHook({ provider });
    const result = await hook.prepareStep(makeContext(1));

    expect(result).toBeUndefined();
  });

  it('caches the result so the provider is only queried once', async () => {
    const provider = createMockSkillProvider([
      makeSkill('code-review', 'Reviews code for quality'),
    ]);

    const hook = createSkillCatalogHook({ provider });

    // Call step 0 twice (e.g., reuse across runs)
    await hook.prepareStep(makeContext(0));
    await hook.prepareStep(makeContext(0));

    const listCalls = provider.calls.filter((call) => call.method === 'listSkills');
    expect(listCalls).toHaveLength(1);
  });

  it('excludes disabled skills', async () => {
    const provider = createMockSkillProvider([
      makeSkill('code-review', 'Reviews code for quality'),
      makeSkill('deploy', 'Deploys applications'),
    ]);

    await provider.setEnabled('deploy', false);

    const hook = createSkillCatalogHook({ provider });
    const result = await hook.prepareStep(makeContext(0));

    expect(result).toContain('code-review');
    expect(result).not.toContain('<skill name="deploy">');
  });

  it('filters skills by allow list from skillPolicy', async () => {
    const provider = createMockSkillProvider([
      makeSkill('code-review', 'Reviews code for quality'),
      makeSkill('deploy', 'Deploys applications'),
      makeSkill('testing', 'Runs tests'),
    ]);

    const hook = createSkillCatalogHook({
      provider,
      skillPolicy: { allowList: ['code-review', 'testing'] },
    });

    const result = await hook.prepareStep(makeContext(0));

    expect(result).toContain('code-review');
    expect(result).toContain('testing');
    expect(result).not.toContain('<skill name="deploy">');
  });

  it('filters skills by deny list from skillPolicy', async () => {
    const provider = createMockSkillProvider([
      makeSkill('code-review', 'Reviews code for quality'),
      makeSkill('deploy', 'Deploys applications'),
      makeSkill('testing', 'Runs tests'),
    ]);

    const hook = createSkillCatalogHook({
      provider,
      skillPolicy: { denyList: ['deploy'] },
    });

    const result = await hook.prepareStep(makeContext(0));

    expect(result).toContain('code-review');
    expect(result).toContain('testing');
    expect(result).not.toContain('<skill name="deploy">');
  });

  it('returns undefined when no skills pass filtering', async () => {
    const provider = createMockSkillProvider([makeSkill('deploy', 'Deploys applications')]);

    const hook = createSkillCatalogHook({
      provider,
      skillPolicy: { denyList: ['deploy'] },
    });

    const result = await hook.prepareStep(makeContext(0));
    expect(result).toBeUndefined();
  });

  it('handles provider errors gracefully by returning undefined', async () => {
    const provider = createMockSkillProvider([]);
    // Override listSkills to throw
    provider.listSkills = async () => {
      throw new Error('Storage unavailable');
    };

    const hook = createSkillCatalogHook({ provider });
    const result = await hook.prepareStep(makeContext(0));

    expect(result).toBeUndefined();
  });

  it('does not retry the provider after an error — caches the error result', async () => {
    const provider = createMockSkillProvider([]);
    let callCount = 0;
    provider.listSkills = async () => {
      callCount++;
      throw new Error('Storage unavailable');
    };

    const hook = createSkillCatalogHook({ provider });

    await hook.prepareStep(makeContext(0));
    await hook.prepareStep(makeContext(0));

    expect(callCount).toBe(1);
  });

  it('formats XML with skill name attribute and description as text content', async () => {
    const provider = createMockSkillProvider([
      makeSkill('code-review', 'Reviews code for quality and correctness'),
    ]);

    const hook = createSkillCatalogHook({ provider });
    const result = await hook.prepareStep(makeContext(0));

    expect(result).toContain(
      '<skill name="code-review">Reviews code for quality and correctness</skill>',
    );
    expect(result).toContain('Use the activate_skill tool to load');
  });

  it('escapes XML special characters in names and descriptions', async () => {
    const skillName = "quote'-skill";
    const description = `Use <fast> & "safe" 'modes'`;
    const provider = createMockSkillProvider([makeSkill(skillName, description)]);

    const hook = createSkillCatalogHook({ provider });
    const result = await hook.prepareStep(makeContext(0));

    expect(result).toContain(
      `<skill name="${escapeXml(skillName)}">${escapeXml(description)}</skill>`,
    );
  });
});
