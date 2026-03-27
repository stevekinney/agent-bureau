import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { scanDirectory } from '../../src/ingestion/scan-directory';
import { createMockSkillProvider } from '../../src/test/index';

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for scanning
---

## Instructions

Do something useful.
`;

function makeSkillMarkdown(name: string, description = `Description for ${name}`): string {
  return `---
name: ${name}
description: ${description}
---

## Instructions for ${name}

Do something useful.
`;
}

const INVALID_SKILL_MD = `---
not-valid: true
---

Missing name and description.
`;

describe('scanDirectory', () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = join(
      tmpdir(),
      `scan-directory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('discovers SKILL.md files in nested directories', async () => {
    const skillDirectory = join(tempDirectory, 'skills', 'my-skill');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), VALID_SKILL_MD);

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.discovered).toBe(1);
    expect(result.loaded).toBe(1);
    expect(result.errors).toHaveLength(0);

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.args[0]).toBe('test-skill');
  });

  it('skips .git directories', async () => {
    const gitDirectory = join(tempDirectory, '.git', 'hooks');
    await mkdir(gitDirectory, { recursive: true });
    await writeFile(join(gitDirectory, 'SKILL.md'), VALID_SKILL_MD);

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.discovered).toBe(0);
    expect(result.loaded).toBe(0);
  });

  it('skips node_modules directories', async () => {
    const nodeModulesDirectory = join(tempDirectory, 'node_modules', 'some-package');
    await mkdir(nodeModulesDirectory, { recursive: true });
    await writeFile(join(nodeModulesDirectory, 'SKILL.md'), VALID_SKILL_MD);

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.discovered).toBe(0);
    expect(result.loaded).toBe(0);
  });

  it('skips hidden directories (starting with .)', async () => {
    const hiddenDirectory = join(tempDirectory, '.hidden-dir', 'sub');
    await mkdir(hiddenDirectory, { recursive: true });
    await writeFile(join(hiddenDirectory, 'SKILL.md'), VALID_SKILL_MD);

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.discovered).toBe(0);
    expect(result.loaded).toBe(0);
  });

  it('respects maxDepth option', async () => {
    // Depth 1: should be found with maxDepth 2
    const shallowDirectory = join(tempDirectory, 'shallow');
    await mkdir(shallowDirectory, { recursive: true });
    await writeFile(join(shallowDirectory, 'SKILL.md'), makeSkillMarkdown('shallow-skill'));

    // Depth 3: should NOT be found with maxDepth 2
    const deepDirectory = join(tempDirectory, 'a', 'b', 'c');
    await mkdir(deepDirectory, { recursive: true });
    await writeFile(join(deepDirectory, 'SKILL.md'), makeSkillMarkdown('deep-skill'));

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider, { maxDepth: 2 });

    expect(result.discovered).toBe(1);
    expect(result.loaded).toBe(1);

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.args[0]).toBe('shallow-skill');
  });

  it('handles parse errors gracefully and continues', async () => {
    const validDirectory = join(tempDirectory, 'valid');
    await mkdir(validDirectory, { recursive: true });
    await writeFile(join(validDirectory, 'SKILL.md'), VALID_SKILL_MD);

    const invalidDirectory = join(tempDirectory, 'invalid');
    await mkdir(invalidDirectory, { recursive: true });
    await writeFile(join(invalidDirectory, 'SKILL.md'), INVALID_SKILL_MD);

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.discovered).toBe(2);
    expect(result.loaded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain('invalid');
    expect(result.errors[0]?.error).toBeTruthy();
  });

  it('ingests resources alongside the skill', async () => {
    const skillDirectory = join(tempDirectory, 'my-skill');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, 'SKILL.md'), VALID_SKILL_MD);
    await writeFile(join(skillDirectory, 'helper.sh'), '#!/bin/bash\necho hello');
    await writeFile(join(skillDirectory, 'data.json'), '{"key": "value"}');

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.loaded).toBe(1);

    const resourceCalls = provider.calls.filter((call) => call.method === 'saveResource');
    expect(resourceCalls).toHaveLength(2);

    const resourceNames = resourceCalls.map((call) => call.args[1]).sort();
    expect(resourceNames).toEqual(['data.json', 'helper.sh']);
  });

  it('returns accurate summary counts', async () => {
    const skill1 = join(tempDirectory, 'skill-one');
    const skill2 = join(tempDirectory, 'skill-two');
    const skill3 = join(tempDirectory, 'skill-three');

    await mkdir(skill1, { recursive: true });
    await mkdir(skill2, { recursive: true });
    await mkdir(skill3, { recursive: true });

    await writeFile(join(skill1, 'SKILL.md'), makeSkillMarkdown('skill-one'));
    await writeFile(join(skill2, 'SKILL.md'), makeSkillMarkdown('skill-two'));
    await writeFile(join(skill3, 'SKILL.md'), INVALID_SKILL_MD);

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.discovered).toBe(3);
    expect(result.loaded).toBe(2);
    expect(result.errors).toHaveLength(1);
  });

  it('returns zero counts for an empty directory', async () => {
    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider);

    expect(result.discovered).toBe(0);
    expect(result.loaded).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('respects maxDirectories option', async () => {
    // Create 5 nested directories each containing a SKILL.md
    for (let index = 1; index <= 5; index++) {
      const skillDirectory = join(tempDirectory, `skill-${index}`);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(join(skillDirectory, 'SKILL.md'), makeSkillMarkdown(`skill-${index}`));
    }

    const provider = createMockSkillProvider();
    const result = await scanDirectory(tempDirectory, provider, { maxDirectories: 3 });

    expect(result.discovered).toBeLessThanOrEqual(3);
  });
});
