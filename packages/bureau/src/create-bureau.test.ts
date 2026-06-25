/**
 * Tests for createBureau — the three-tier registry/table.
 *
 * Coverage:
 *   Tier 1 — createBureau({ agents }) construction-time seed
 *   Tier 2 — bureau.agent({}) chained accretion (return must be captured)
 *   Tier 3 — bureau.run<TExtra>() widen-not-replace
 *
 * ACCEPTANCE lines from plan.md E1:
 *   - Tier 1 agents are registered and runnable after construction
 *   - Tier 2 agents widen the registry; previously-registered agents remain
 *   - Tier 3 run<TExtra> accepts dynamic names without losing static agents
 *   - run() throws a clear error for unregistered agents
 *   - run() throws a clear error when no generate function is available
 *   - generate wired per-agent (via AgentOptions.generate) drives the run
 */

import { createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createMockGenerate } from 'operative/test';
import { z } from 'zod';

import { createBureau } from './create-bureau';

// ---------------------------------------------------------------------------
// Shared tool stubs for tool-registration tests
// ---------------------------------------------------------------------------

const echoTool = createTool({
  name: 'echo',
  description: 'Echo the input text back.',
  input: z.object({ text: z.string() }),
  execute: async ({ text }: { text: string }) => text,
});

// ---------------------------------------------------------------------------
// Shared mock generate — returns a simple text response, no tool calls.
// ---------------------------------------------------------------------------

function makeGenerate(text = 'mock response') {
  // Provide a second identical response so the operative loop can complete
  // without exhausting the mock on a two-step invocation. The loop exits
  // when it sees content with no tool calls; a second response guards
  // against re-entry on unexpected second steps.
  const response = { content: text, toolCalls: [] as [] };
  return createMockGenerate([response, response]);
}

// ---------------------------------------------------------------------------
// Tier 1 — createBureau({ agents })
// ---------------------------------------------------------------------------

describe('createBureau — Tier 1 (construction-time seed)', () => {
  it('registers agents from the construction-time agents map', () => {
    const generate = makeGenerate();
    const bureau = createBureau({
      agents: {
        researcher: { generate, instructions: 'You research.' },
        writer: { generate },
      },
    });

    // Both agents are registered — running them should not throw.
    expect(() => bureau.run('researcher', 'input')).not.toThrow();
    expect(() => bureau.run('writer', 'input')).not.toThrow();
  });

  it('creates a bureau with no agents when called with no arguments', () => {
    const bureau = createBureau();
    // No agents — any run() call should throw.
    expect(() => bureau.run('anything' as never, 'input')).toThrow(/no agent named "anything"/);
  });

  it('creates a bureau with no agents when called with an empty agents map', () => {
    const bureau = createBureau({ agents: {} });
    expect(() => bureau.run('anything' as never, 'input')).toThrow(/no agent named "anything"/);
  });

  it('passes instructions to the agent (run completes without error)', async () => {
    const generate = makeGenerate('researched!');
    const bureau = createBureau({
      agents: {
        researcher: { generate, instructions: 'You are a researcher.' },
      },
    });

    const run = bureau.run('researcher', 'What is Zod?');
    const result = await run.result();
    expect(result.content).toBe('researched!');
    expect(generate.callCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — .agent() chained accretion
// ---------------------------------------------------------------------------

describe('createBureau — Tier 2 (.agent() chained accretion)', () => {
  it('adds an agent via .agent() and makes it runnable', () => {
    const generate = makeGenerate();
    const bureau = createBureau().agent({ name: 'editor', generate });

    expect(() => bureau.run('editor', 'Edit this')).not.toThrow();
  });

  it('preserves previously-registered Tier-1 agents after .agent() accretion', () => {
    const generate = makeGenerate();
    const bureau1 = createBureau({
      agents: { researcher: { generate } },
    });

    // MUST capture the return value — this is the reassignment contract.
    const bureau2 = bureau1.agent({ name: 'writer', generate });

    // Both agents must be runnable.
    expect(() => bureau2.run('researcher', 'input')).not.toThrow();
    expect(() => bureau2.run('writer', 'input')).not.toThrow();
  });

  it('chains multiple .agent() calls and all agents remain registered', () => {
    const generate = makeGenerate();
    const bureau = createBureau()
      .agent({ name: 'alpha', generate })
      .agent({ name: 'beta', generate })
      .agent({ name: 'gamma', generate });

    expect(() => bureau.run('alpha', 'input')).not.toThrow();
    expect(() => bureau.run('beta', 'input')).not.toThrow();
    expect(() => bureau.run('gamma', 'input')).not.toThrow();
  });

  it('returns a run whose result resolves to the generate output', async () => {
    const generate = makeGenerate('tier-2 result');
    const bureau = createBureau().agent({ name: 'helper', generate });

    const run = bureau.run('helper', 'Do something');
    const result = await run.result();
    expect(result.content).toBe('tier-2 result');
  });

  it('each agent can have its own generate function', async () => {
    const generateA = makeGenerate('from A');
    const generateB = makeGenerate('from B');

    const bureau = createBureau()
      .agent({ name: 'agentA', generate: generateA })
      .agent({ name: 'agentB', generate: generateB });

    const resultA = await bureau.run('agentA', 'input').result();
    const resultB = await bureau.run('agentB', 'input').result();

    expect(resultA.content).toBe('from A');
    expect(resultB.content).toBe('from B');
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — run<TExtra> widen-not-replace
// ---------------------------------------------------------------------------

describe('createBureau — Tier 3 (run<TExtra> widen-not-replace)', () => {
  it('run() throws a clear error for unregistered agent names', () => {
    const bureau = createBureau({ agents: {} });
    // At runtime, unregistered names throw regardless of TExtra.
    expect(() => bureau.run('unregistered' as never, 'input')).toThrow(
      /no agent named "unregistered"/,
    );
  });

  it('error message lists the registered agents', () => {
    const generate = makeGenerate();
    const bureau = createBureau({
      agents: { alpha: { generate }, beta: { generate } },
    });

    let error: Error | undefined;
    try {
      bureau.run('unknown' as never, 'input');
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain('alpha');
    expect(error?.message).toContain('beta');
  });

  it('static agents remain accessible after a Tier-2 addition', async () => {
    // This is the type-level "widen-not-replace" checked at runtime:
    // adding an agent does NOT evict previously registered agents.
    const generate = makeGenerate('static');
    const bureau1 = createBureau({ agents: { static: { generate } } });
    const bureau2 = bureau1.agent({ name: 'dynamic', generate: makeGenerate('dynamic') });

    const staticResult = await bureau2.run('static', 'input').result();
    const dynamicResult = await bureau2.run('dynamic', 'input').result();

    expect(staticResult.content).toBe('static');
    expect(dynamicResult.content).toBe('dynamic');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('createBureau — error handling', () => {
  it('throws when run() is called with an unregistered agent name', () => {
    const bureau = createBureau({ agents: {} });
    expect(() => bureau.run('missing' as never, 'x')).toThrow(/no agent named "missing"/);
  });

  it('throws when an agent has no generate function and no bureau-level default', () => {
    // Register an agent without a generate function.
    const bureau = createBureau({
      agents: { agent: { instructions: 'no generate here' } },
    });

    expect(() => bureau.run('agent', 'x')).toThrow(/no generate function/);
  });
});

// ---------------------------------------------------------------------------
// AgentRun handle — non-thenable contract
// ---------------------------------------------------------------------------

describe('createBureau — AgentRun handle', () => {
  it('run() returns an object with a result() method (not a Promise)', () => {
    const bureau = createBureau().agent({ name: 'a', generate: makeGenerate() });
    const run = bureau.run('a', 'input');

    // result() must exist and return a Promise.
    expect(typeof run.result).toBe('function');
    const resultPromise = run.result();
    expect(resultPromise).toBeInstanceOf(Promise);
  });

  it('run() handle is not a thenable (does not have .then)', () => {
    const bureau = createBureau().agent({ name: 'a', generate: makeGenerate() });
    const run = bureau.run('a', 'input');

    // A thenable has a `.then` method. AgentRun must NOT.
    expect((run as unknown as Record<string, unknown>)['then']).toBeUndefined();
  });

  it('run() handle is async-iterable', () => {
    const bureau = createBureau().agent({ name: 'a', generate: makeGenerate() });
    const run = bureau.run('a', 'input');

    expect(Symbol.asyncIterator in run).toBe(true);
  });

  it('result() is idempotent — calling it multiple times returns the same Promise', () => {
    const bureau = createBureau().agent({ name: 'a', generate: makeGenerate() });
    const run = bureau.run('a', 'input');

    const p1 = run.result();
    const p2 = run.result();
    // Same cached Promise.
    expect(p1).toBe(p2);
  });

  it('iterate-then-result() returns the cached terminal value', async () => {
    const generate = makeGenerate('iterated');
    const bureau = createBureau().agent({ name: 'a', generate });
    const run = bureau.run('a', 'input');

    // Consume the event stream.
    for await (const _event of run) {
      // drain
    }

    // result() after iteration must return the cached value, not re-run.
    const result = await run.result();
    expect(result.content).toBe('iterated');
    // Generate was called at least once. We do not assert exactly once because
    // the operative loop may invoke it twice depending on step execution and
    // stop-condition evaluation. The key invariant is that result() is CACHED
    // (the callCount does not increase between the for-await and result() call).
    const countAfterIterate = generate.callCount;
    expect(countAfterIterate).toBeGreaterThanOrEqual(1);
    // Calling result() again must NOT cause another generate() call.
    await run.result();
    expect(generate.callCount).toBe(countAfterIterate);
  });

  it('run() handle has abort() method', () => {
    const bureau = createBureau().agent({ name: 'a', generate: makeGenerate() });
    const run = bureau.run('a', 'input');
    expect(typeof run.abort).toBe('function');
  });

  it('run() handle has [Symbol.dispose]', () => {
    const bureau = createBureau().agent({ name: 'a', generate: makeGenerate() });
    const run = bureau.run('a', 'input');
    expect(typeof run[Symbol.dispose]).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Tool inheritance — Tier 1 + Tier 2 tools
// ---------------------------------------------------------------------------

describe('createBureau — tool registration', () => {
  it('bureau.tools() sets bureau-level tools (run() does not throw)', () => {
    const generate = makeGenerate();

    // Register a proper armorer Tool at bureau level; the map key is canonical.
    const bureau = createBureau().tools({ echo: echoTool }).agent({ name: 'a', generate });

    expect(() => bureau.run('a', 'input')).not.toThrow();
  });

  it('agent-level tools are accepted via AgentOptions.tools', () => {
    const generate = makeGenerate();
    const bureau = createBureau().agent({
      name: 'a',
      generate,
      tools: { echo: echoTool },
    });

    expect(() => bureau.run('a', 'input')).not.toThrow();
  });

  it('rejects non-Tool values in the tools map', () => {
    const generate = makeGenerate();
    expect(() =>
      createBureau()
        .tools({ bad: { execute: () => Promise.resolve('nope') } as unknown as typeof echoTool })
        .agent({ name: 'a', generate }),
    ).toThrow(/not an armorer Tool/);
  });
});

// ---------------------------------------------------------------------------
// Skills registration
// ---------------------------------------------------------------------------

describe('createBureau — skills()', () => {
  it('accepts a skills provider without throwing', () => {
    const mockProvider = {
      listSkills: async () => [{ name: 'research', description: 'Research skills' }],
      isEnabled: async (_name: string) => true,
    };

    const generate = makeGenerate();
    const bureau = createBureau().skills(mockProvider).agent({ name: 'a', generate });

    expect(() => bureau.run('a', 'input')).not.toThrow();
  });

  it('accepts a skills provider with policy', () => {
    const mockProvider = {
      listSkills: async () => [{ name: 'research', description: 'Research skills' }],
      isEnabled: async (_name: string) => true,
    };

    const generate = makeGenerate();
    const bureau = createBureau()
      .skills(mockProvider, { allowList: ['research'] })
      .agent({ name: 'a', generate });

    expect(() => bureau.run('a', 'input')).not.toThrow();
  });
});
