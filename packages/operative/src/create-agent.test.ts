/**
 * AB-241: `AgentRunContext.principal` forwards into `RunOptions.principal`
 * on `createAgent`'s run path, the same way `signal`/`traceContext` already
 * forward — proven here through `OPERATIVE_RESOLVE_RUN_OPTIONS` (AB-21's
 * definition-resolution protocol), which resolves the exact `RunOptions` bag
 * `run()` itself builds, without starting an in-memory run.
 */
import { describe, expect, it } from 'bun:test';

import { createAgent } from './create-agent';
import type { DefinitionResolvingAgent } from './runnable-agent';
import { OPERATIVE_RESOLVE_RUN_OPTIONS } from './runnable-agent';
import type { RunOptions } from './types';

function mockGenerate() {
  return async () => ({ content: 'ok', toolCalls: [] });
}

function resolver(agent: ReturnType<typeof createAgent>) {
  return (agent as unknown as DefinitionResolvingAgent)[OPERATIVE_RESOLVE_RUN_OPTIONS] as (
    input: string,
    context?: { principal?: string },
  ) => Promise<RunOptions>;
}

describe('createAgent: AgentRunContext.principal forwarding (AB-241)', () => {
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
