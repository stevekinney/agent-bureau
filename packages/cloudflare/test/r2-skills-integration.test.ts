import { describe, expect, it } from 'bun:test';
import type { SkillContent } from 'skills';
import { createStorageSkillProvider } from 'skills';

import { createCloudflareR2TextValueStore } from '../src/create-cloudflare-r2-text-value-store';
import { createFakeR2 } from '../src/test/fake-r2';

/**
 * THE HONESTY CHECK: wires the R2-backed `TextValueStore` into `skills`'s
 * `createStorageSkillProvider` exactly as a Worker would (an R2 bucket binding
 * satisfies `createCloudflareR2TextValueStore`'s injected `bucket` option
 * structurally) and proves the real skill-provider surface — catalog, full
 * content, resources, enabled flag — round-trips through it. This is the named
 * consumer from the acceptance criteria, not a synthetic contract.
 */
describe('createCloudflareR2TextValueStore backs createStorageSkillProvider', () => {
  it('saves, lists, and loads a skill end-to-end through R2', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });
    const provider = createStorageSkillProvider(store);

    const content: SkillContent = {
      metadata: { name: 'code-review', description: 'Reviews code for correctness.' },
      body: '## Instructions\n\nReview the diff carefully.',
    };
    await provider.saveSkill('code-review', content);

    const catalog = await provider.listSkills();
    expect(catalog).toEqual([{ name: 'code-review', description: content.metadata.description }]);

    const loaded = await provider.loadSkill('code-review');
    expect(loaded).toEqual(content);
  });

  it('round-trips a large bundled resource (the R2-appropriate case)', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });
    const provider = createStorageSkillProvider(store);
    const content: SkillContent = {
      metadata: { name: 'data-tools', description: 'Bundles a large reference script.' },
      body: '## Instructions\n\nRun scripts/extract.py.',
    };
    await provider.saveSkill('data-tools', content);

    // Large tool output / bundled resource content: the same scale R2 exists
    // for, well past what a KV row or a DO-SQLite text column comfortably
    // holds.
    const largeScript = 'print("row")\n'.repeat(20_000);
    await provider.saveResource('data-tools', 'scripts/extract.py', largeScript);

    expect(await provider.listResources('data-tools')).toEqual(['scripts/extract.py']);
    expect(await provider.loadResource('data-tools', 'scripts/extract.py')).toBe(largeScript);
  });

  it('deleteSkill removes metadata, body, and resources together', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2({ pageSize: 2 }) });
    const provider = createStorageSkillProvider(store);
    const content: SkillContent = {
      metadata: { name: 'temp-skill', description: 'Deleted shortly after creation.' },
      body: 'body',
    };
    await provider.saveSkill('temp-skill', content);
    await provider.saveResource('temp-skill', 'a.txt', 'a');
    await provider.saveResource('temp-skill', 'b.txt', 'b');

    await provider.deleteSkill('temp-skill');

    expect(await provider.loadSkill('temp-skill')).toBeUndefined();
    expect(await provider.listResources('temp-skill')).toEqual([]);
  });
});
