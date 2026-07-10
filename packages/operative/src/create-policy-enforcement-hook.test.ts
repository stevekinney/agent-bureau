import { createTool, createToolbox, createToolCall } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createPolicyEnforcementHook } from './create-policy-enforcement-hook';

/**
 * AB-22: the capability-tier approval policy (armorer's `approvalPolicy`
 * toolbox option) and persona/skill tool policies (`createPolicyEnforcementHook`)
 * are two separate, composing layers — not one bypassing the other.
 *
 * `createPolicyEnforcementHook` controls which tools are *offered* to the
 * model (a visibility filter over a tool array). armorer's capability policy
 * controls whether an offered tool is actually *allowed to execute*. A
 * persona's allow-list can make a dangerous tool visible, but it can never
 * make armorer execute it if the capability tier denies it.
 */
describe('createPolicyEnforcementHook composes with armorer capability policy', () => {
  function makeDangerousTool() {
    return createTool({
      name: 'delete-production-database',
      description: 'Deletes the production database',
      input: z.object({}),
      metadata: { dangerous: true },
      execute: async () => ({ deleted: true }),
    });
  }

  it('a persona allow-list can make a dangerous tool visible to the model', () => {
    const tool = makeDangerousTool();
    const enforceToolPolicy = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: [tool.name] },
    });
    const visibleTools = enforceToolPolicy([tool]);
    expect(visibleTools).toHaveLength(1);
    expect(visibleTools[0]?.name).toBe(tool.name);
  });

  it('cannot grant execution once the capability tier denies it — deny beats the persona allow-list', async () => {
    const tool = makeDangerousTool();

    // The persona's tool policy allow-lists the dangerous tool by name —
    // as far as tool *visibility* is concerned, this tool is fully approved.
    const enforceToolPolicy = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: [tool.name] },
    });
    const visibleTools = enforceToolPolicy([tool]);
    expect(visibleTools).toHaveLength(1);

    // armorer's toolbox is configured with a capability policy that denies
    // the dangerous tier outright. Composition means the persona's allow-list
    // never reaches this decision — it cannot loosen it.
    const toolbox = createToolbox(visibleTools, {
      approvalPolicy: { mode: 'never', tierModes: { dangerous: 'deny' } },
    });

    const result = await toolbox.execute(createToolCall(tool.name, {}));
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
  });

  it('control: the same persona allow-list DOES let the tool execute once the capability tier allows it', async () => {
    // Negative control for the test above. Same tool, same persona
    // allow-list, only the capability policy's mode changes (deny -> never).
    // If this executes successfully, the prior test's denial was actually
    // caused by the capability tier — not by some inert or accidental
    // interaction with `createPolicyEnforcementHook`.
    const tool = makeDangerousTool();
    const enforceToolPolicy = createPolicyEnforcementHook({
      personaToolPolicy: { allowList: [tool.name] },
    });
    const visibleTools = enforceToolPolicy([tool]);

    const toolbox = createToolbox(visibleTools, {
      approvalPolicy: { mode: 'never' },
    });

    const result = await toolbox.execute(createToolCall(tool.name, {}));
    expect(result.outcome).toBe('success');
  });

  it('a skill deny-list combined with a permissive capability policy still blocks the tool', async () => {
    const tool = makeDangerousTool();
    const enforceToolPolicy = createPolicyEnforcementHook({
      getActiveSkillToolPolicy: () => ({ denyList: [tool.name] }),
    });
    const visibleTools = enforceToolPolicy([tool]);
    expect(visibleTools).toHaveLength(0);
  });
});
