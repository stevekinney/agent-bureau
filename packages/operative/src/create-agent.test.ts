/**
 * AB-241: `AgentRunContext.principal` forwards into `RunOptions.principal`
 * on `createAgent`'s run path, the same way `signal`/`traceContext` already
 * forward — proven here through `OPERATIVE_RESOLVE_RUN_OPTIONS` (AB-21's
 * definition-resolution protocol), which resolves the exact `RunOptions` bag
 * `run()` itself builds, without starting an in-memory run.
 */
import { describe, expect, it } from 'bun:test';

import { createAgent } from './create-agent';
import { hasDefinitionResolver, OPERATIVE_RESOLVE_RUN_OPTIONS } from './runnable-agent';

function mockGenerate() {
  return async () => ({ content: 'ok', toolCalls: [] });
}

function resolver(agent: ReturnType<typeof createAgent>) {
  if (!hasDefinitionResolver(agent)) throw new Error('expected a createAgent resolver');
  return agent[OPERATIVE_RESOLVE_RUN_OPTIONS];
}

describe('createAgent: AgentRunContext.principal forwarding (AB-241)', () => {
  it('checks the symbol capability without accepting an ordinary agent-like object', () => {
    const agent = createAgent({ generate: mockGenerate() });

    expect(hasDefinitionResolver(agent)).toBe(true);
    expect(hasDefinitionResolver({})).toBe(false);
  });

  it('forwards context.principal into RunOptions.principal, matching signal/traceContext forwarding', async () => {
    const agent = createAgent({ generate: mockGenerate() });

    const options = await resolver(agent)('hi', { principal: 'user-42' });

    expect(options.principal).toBe('user-42');
  });

  it('leaves RunOptions.principal undefined when the context omits it, behaving exactly as before this field existed', async () => {
    const agent = createAgent({ generate: mockGenerate() });

    const options = await resolver(agent)('hi');

    expect(options.principal).toBeUndefined();
  });
});
