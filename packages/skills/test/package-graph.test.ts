// E3 — Confirm skills stays a package (runtime behavioral tests)
//
// This file verifies the architectural decision documented in architecture.md
// and plan.md Phase E3: the `skills` package is a coherent subsystem at the
// correct layer of the dependency graph — same layer as `memory`, below
// `operative` and above `bureau`.
//
// The acceptance criterion from plan.md E3:
//   package graph: interoperability/lifecycle → armorer/conversationalist →
//     operative(+herald subpaths) → memory/skills → bureau → gateway
//
// Runtime tests (this file) verify:
//   1. The skills package has the correct workspace dependencies and no
//      forbidden ones (no operative, memory, conversationalist, lifecycle).
//   2. SkillProvider's listSkills() and isEnabled() satisfy the SkillProviderLike
//      contract that the bureau builder consumes via its structural seam.
//   3. ToolPolicy's deny-wins semantics are consistent with operative's
//      ToolPolicyLike — confirming the E4 extraction is coherent.
//
// Type-level assertions (structural compatibility) live in package-graph.test-d.ts.

import { describe, expect, it } from 'bun:test';

// ── 1. Package Graph Position ─────────────────────────────────────────────────

describe('E3: skills package graph position', () => {
  it('has no forbidden workspace dependencies', async () => {
    // Read the skills package.json from disk to assert its dependency surface.
    const packageJson = (await import('../package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = Object.keys(packageJson.dependencies ?? {});

    // Forbidden workspace dependencies — these would break the layer contract.
    // Skills is at the memory layer: deps are armorer and interoperability only.
    const forbiddenWorkspaceDeps = [
      'operative', // skills is ABOVE operative's layer
      'memory', // same layer — no intra-layer import
      'conversationalist', // skills is above conversationalist
      'lifecycle', // transitively available via armorer; not needed directly
      'bureau', // bureau is above skills
      'gateway', // gateway is above skills
      'sentinel', // unrelated
      'evaluation', // unrelated
      'integration', // unrelated
    ];

    for (const forbidden of forbiddenWorkspaceDeps) {
      expect(deps).not.toContain(forbidden);
    }
  });

  it('depends on armorer (same layer — tools/seams) and interoperability (zero-dep primitive)', async () => {
    const packageJson = (await import('../package.json')) as {
      dependencies?: Record<string, string>;
    };

    const deps = Object.keys(packageJson.dependencies ?? {});

    // These are the ALLOWED workspace deps for this layer.
    expect(deps).toContain('armorer');
    expect(deps).toContain('interoperability');
  });
});

// ── 2. SkillProvider ⊇ SkillProviderLike (behavioral compatibility) ───────────

// The bureau builder's `.skills(provider)` accepts a `SkillProviderLike`:
//   { listSkills(): Promise<Array<{name:string;description:string}>>; isEnabled(name:string):Promise<boolean> }
//
// SkillProvider (from this package) must be a SUPERSET — it satisfies the seam
// without the bureau needing to import from `skills` directly.
// The type-level proof is in package-graph.test-d.ts.

describe('E3: SkillProvider satisfies the bureau SkillProviderLike seam (behavioral)', () => {
  it('listSkills() returns name + description for each skill', async () => {
    const { createStaticSkillProvider } = await import('../src');

    const provider = createStaticSkillProvider([
      {
        metadata: { name: 'test-skill', description: 'A skill for testing.' },
        body: '## Instructions\n\nDo the thing.',
      },
    ]);

    const skills = await provider.listSkills();

    expect(skills).toHaveLength(1);
    // The return shape must include name + description (SkillProviderLike contract).
    const skill = skills[0];
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('test-skill');
    expect(skill!.description).toBe('A skill for testing.');
  });

  it('listSkills() returns catalog entries for multiple skills', async () => {
    const { createStaticSkillProvider } = await import('../src');

    const provider = createStaticSkillProvider([
      {
        metadata: { name: 'skill-one', description: 'First skill.' },
        body: '## Skill One',
      },
      {
        metadata: { name: 'skill-two', description: 'Second skill.' },
        body: '## Skill Two',
      },
    ]);

    const skills = await provider.listSkills();

    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name);
    expect(names).toContain('skill-one');
    expect(names).toContain('skill-two');
  });

  it('isEnabled() returns boolean — defaults to true for all skills', async () => {
    const { createStaticSkillProvider } = await import('../src');

    const provider = createStaticSkillProvider([
      {
        metadata: { name: 'my-skill', description: 'My skill.' },
        body: '## My Skill',
      },
    ]);

    // Static provider has no enabled/disabled state — all skills enabled by default.
    const enabled = await provider.isEnabled('my-skill');
    expect(enabled).toBe(true);
  });

  it('isEnabled() returns true even for non-existent skill names', async () => {
    const { createStaticSkillProvider } = await import('../src');

    const provider = createStaticSkillProvider([]);

    // Non-existent skill: no explicit disabled state, defaults to true.
    const enabled = await provider.isEnabled('non-existent-skill');
    expect(enabled).toBe(true);
  });
});

// ── 3. ToolPolicy deny-wins semantics (E4 extraction coherence) ───────────────

// plan.md E4 extracts ToolPolicy from skills/types.ts to a shared package.
// E3's role: confirm the shape and semantics are coherent and consistent with
// operative's ToolPolicyLike — deny wins over allow in both packages.

describe('E3: ToolPolicy deny-wins semantics (E4 extraction coherence)', () => {
  it('skill session exposes the active skill tool policy after activation', async () => {
    const { createSkillSession } = await import('../src');

    const session = createSkillSession();

    // Activate a skill with an explicit tool policy (deny wins over allow).
    session.activate('restricted-skill', {
      allowList: ['read', 'write'],
      denyList: ['write'],
    });

    const policy = session.getActiveToolPolicy();

    // Policy should be present after activation.
    expect(policy).toBeDefined();

    // Deny list should contain 'write'.
    expect(policy!.denyList).toContain('write');
    // Allow list is still present (the caller — operative's createPolicyEnforcementHook
    // — applies deny-wins logic when filtering tools).
    expect(policy!.allowList).toContain('read');
  });

  it('skill session returns undefined policy when no skill is active', async () => {
    const { createSkillSession } = await import('../src');

    const session = createSkillSession();
    // No activation — no active policy.
    const policy = session.getActiveToolPolicy();

    expect(policy).toBeUndefined();
  });

  it('skill session returns undefined policy when active skill has no toolPolicy', async () => {
    const { createSkillSession } = await import('../src');

    const session = createSkillSession();
    // Activate with no tool policy.
    session.activate('no-policy-skill', undefined);

    const policy = session.getActiveToolPolicy();

    // Active skill has no toolPolicy field — should return undefined.
    expect(policy).toBeUndefined();
  });

  it('skill session merges tool policies across multiple active skills (deny union, allow intersection)', async () => {
    const { createSkillSession } = await import('../src');

    const session = createSkillSession();

    // Two skills with overlapping but distinct policies.
    session.activate('skill-a', { allowList: ['read', 'write', 'execute'], denyList: ['delete'] });
    session.activate('skill-b', { allowList: ['read', 'execute', 'search'], denyList: ['write'] });

    const policy = session.getActiveToolPolicy();

    expect(policy).toBeDefined();
    // Allow list: INTERSECTION — only tools present in BOTH allow lists.
    // read and execute are in both; write and search are not in both.
    expect(policy!.allowList).toEqual(expect.arrayContaining(['read', 'execute']));
    expect(policy!.allowList).not.toContain('write');
    expect(policy!.allowList).not.toContain('search');
    // Deny list: UNION — either skill denying a tool denies it for all.
    expect(policy!.denyList).toEqual(expect.arrayContaining(['delete', 'write']));
  });
});
