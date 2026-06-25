/**
 * Bureau test utilities.
 *
 * Re-exports operative's test helpers that bureau tests commonly need, plus
 * bureau-specific convenience factories for setting up test bureaus without
 * a live LLM provider.
 *
 * Usage:
 *
 * ```ts
 * import { createMockGenerate, createTestBureau } from 'bureau/test';
 *
 * const generate = createMockGenerate([{ content: [{ type: 'text', text: 'ok' }] }]);
 * const bureau = createTestBureau({ generate, agents: ['researcher', 'writer'] });
 *
 * const run = bureau.run('researcher', 'Summarize Q3');
 * const result = await run.result();
 * ```
 */

// Re-export operative test utilities used in bureau tests.
import type { GenerateFunction } from 'operative';

import { createBureau } from '../create-bureau';
import type { BureauBuilder } from '../types';

export type { GenerateFunction } from 'operative';
export { createMockGenerate, createMockGenerateOnce } from 'operative/test';

// ---------------------------------------------------------------------------
// createTestBureau — convenience factory for bureau tests
// ---------------------------------------------------------------------------

/**
 * Creates a bureau pre-wired with a mock generate function and a set of
 * registered agents. Each agent shares the same generate function.
 *
 * This is the simplest way to set up a bureau for testing without a live
 * LLM provider. The returned bureau has no tools by default.
 *
 * @example
 * ```ts
 * const generate = createMockGenerate([{ content: [{ type: 'text', text: 'done' }] }]);
 * const bureau = createTestBureau({ generate, agents: ['researcher'] });
 *
 * const run = bureau.run('researcher', 'What is 2+2?');
 * const result = await run.result();
 * expect(result.content).toBe('done');
 * ```
 */
export function createTestBureau(options: {
  /** Mock generate function to inject into every registered agent. */
  generate: GenerateFunction;
  /** Agent names to register. Defaults to `['agent']`. */
  agents?: string[];
  /** Optional instructions applied to all agents. */
  instructions?: string;
}): BureauBuilder {
  const { generate, agents = ['agent'], instructions } = options;

  // Build agent seed map for Tier-1 construction.
  const agentSeed: Record<string, { generate: GenerateFunction; instructions?: string }> = {};
  for (const name of agents) {
    agentSeed[name] = { generate, instructions };
  }

  return createBureau({ agents: agentSeed }) as BureauBuilder;
}
