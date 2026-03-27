import { describe, expect, it } from 'bun:test';

import {
  createPolicyEnforcementHook,
  type ToolPolicyLike,
} from '../src/create-policy-enforcement-hook';

interface MockTool {
  name: string;
}

function createMockTools(...names: string[]): MockTool[] {
  return names.map((name) => ({ name }));
}

describe('createPolicyEnforcementHook', () => {
  const allTools = createMockTools('read', 'write', 'execute', 'delete');

  it('passes all tools through when no policies are provided', () => {
    const filter = createPolicyEnforcementHook({});
    const result = filter(allTools);
    expect(result).toEqual(allTools);
  });

  it('filters to only allowed tools when persona has an allow list', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: ['read', 'write'] },
    });
    const result = filter(allTools);
    expect(result).toEqual(createMockTools('read', 'write'));
  });

  it('excludes denied tools when persona has a deny list', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { denyList: ['delete'] },
    });
    const result = filter(allTools);
    expect(result).toEqual(createMockTools('read', 'write', 'execute'));
  });

  it('deny list wins when a tool appears in both allow and deny lists', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: ['read', 'write'], denyList: ['write'] },
    });
    const result = filter(allTools);
    expect(result).toEqual(createMockTools('read'));
  });

  it('composes skill tool policy with persona tool policy as intersection', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: ['read', 'write', 'execute'] },
      getActiveSkillToolPolicy: () => ({ allowList: ['read', 'execute'] }),
    });
    const result = filter(allTools);
    expect(result).toEqual(createMockTools('read', 'execute'));
  });

  it('applies only persona policy when no active skill is present', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: ['read', 'write'] },
      getActiveSkillToolPolicy: () => undefined,
    });
    const result = filter(allTools);
    expect(result).toEqual(createMockTools('read', 'write'));
  });

  it('reflects changes when getActiveSkillToolPolicy returns different values', () => {
    let skillPolicy: ToolPolicyLike | undefined = { allowList: ['read'] };

    const filter = createPolicyEnforcementHook({
      getActiveSkillToolPolicy: () => skillPolicy,
    });

    expect(filter(allTools)).toEqual(createMockTools('read'));

    skillPolicy = { allowList: ['write', 'execute'] };
    expect(filter(allTools)).toEqual(createMockTools('write', 'execute'));

    skillPolicy = undefined;
    expect(filter(allTools)).toEqual(allTools);
  });

  it('returns no tools when persona allow list is empty', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: [] },
    });
    const result = filter(allTools);
    expect(result).toEqual([]);
  });

  it('passes all tools through when persona deny list is empty', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { denyList: [] },
    });
    const result = filter(allTools);
    expect(result).toEqual(allTools);
  });

  it('denies a tool allowed by persona when active skill denies it', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: ['read', 'write', 'bash'] },
      getActiveSkillToolPolicy: () => ({ denyList: ['bash'] }),
    });
    const tools = createMockTools('read', 'write', 'bash');
    const result = filter(tools);
    expect(result).toEqual(createMockTools('read', 'write'));
  });

  it('returns only tools present in both allow lists when both policies have allow lists', () => {
    const filter = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: ['read', 'write', 'execute'] },
      getActiveSkillToolPolicy: () => ({ allowList: ['write', 'delete'] }),
    });
    const result = filter(allTools);
    // Persona allows: read, write, execute
    // Skill allows: write, delete
    // Intersection: write (delete was already excluded by persona)
    expect(result).toEqual(createMockTools('write'));
  });
});
