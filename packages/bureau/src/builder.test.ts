/**
 * Tests for the typed bureau fleet builder (bureau/builder).
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
import type { ToolStartedBubbleEvent } from 'operative';
import { createMockGenerate } from 'operative/test';
import { z } from 'zod';

import { createBureau } from './builder';

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

describe('createBureau (builder) — Tier 1 (construction-time seed)', () => {
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

describe('createBureau (builder) — Tier 2 (.agent() chained accretion)', () => {
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

describe('createBureau (builder) — Tier 3 (run<TExtra> widen-not-replace)', () => {
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

describe('createBureau (builder) — error handling', () => {
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

describe('createBureau (builder) — AgentRun handle', () => {
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

describe('createBureau (builder) — tool registration', () => {
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

  it('rejects genuinely invalid values in the tools map (non-function primitives)', () => {
    const generate = makeGenerate();
    expect(() =>
      // Passing 42 forces the unhappy path; cast is required to bypass TypeScript.
      createBureau()
        .tools({ bad: 42 as unknown as typeof echoTool })
        .agent({ name: 'a', generate }),
    ).toThrow(/not a valid tool entry/);
  });

  it('accepts a plain { execute } object and normalizes it to an armorer Tool', () => {
    const generate = makeGenerate();
    expect(() =>
      createBureau()
        .tools({ search: { execute: () => Promise.resolve('ok') } as unknown as typeof echoTool })
        .agent({ name: 'a', generate }),
    ).not.toThrow();
  });

  it('accepts a bare function and normalizes it to an armorer Tool', () => {
    const generate = makeGenerate();
    expect(() =>
      createBureau()
        .tools({ ping: (() => Promise.resolve('pong')) as unknown as typeof echoTool })
        .agent({ name: 'a', generate }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// bureau/builder subpath barrel — re-export smoke test
// ---------------------------------------------------------------------------
//
// Regression guard for PRRT_kwDORvupsc6MUE_r: the bureau/builder subpath
// export was previously not included in the build script (scripts/build.ts),
// so dist/builder/index.{js,cjs,d.ts} were never emitted. The package.json
// export conditions also pointed at ./src/builder/index.ts (TypeScript source)
// instead of dist/ for the browser/import/require/default conditions,
// breaking resolution for non-Bun/non-TS-aware consumers.
//
// This test ensures createBureau is reachable through the barrel that
// bureau/builder resolves to, so a future entrypoint omission causes a test
// failure rather than a silent broken npm artifact.

describe('bureau/builder subpath barrel', () => {
  it('exports createBureau from the subpath barrel', async () => {
    // Dynamic import of the barrel file that ./builder resolves to at runtime.
    // If scripts/build.ts ever drops ./src/builder/index.ts from entrypoints,
    // this import would succeed in bun (source-aware) but the built artifact
    // would be missing — the package.json export condition change makes that
    // gap visible even in non-bun resolvers.
    const { createBureau: createBureauFromBarrel } = await import('./builder/index');
    expect(typeof createBureauFromBarrel).toBe('function');
  });

  it('builder barrel createBureau produces a runnable bureau', async () => {
    const { createBureau: createBureauFromBarrel } = await import('./builder/index');
    const generate = makeGenerate('barrel-ok');
    const bureau = createBureauFromBarrel().agent({ name: 'a', generate });
    const result = await bureau.run('a', 'input').result();
    expect(result.content).toBe('barrel-ok');
  });
});

// ---------------------------------------------------------------------------
// Skills registration
// ---------------------------------------------------------------------------

describe('createBureau (builder) — skills()', () => {
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

  // ---------------------------------------------------------------------------
  // Regression: builder.skills() had no effect — the skill catalog was stored
  // on state but never read by run(). Tests below verify catalog injection.
  // ---------------------------------------------------------------------------

  /**
   * Build a capturing generate wrapper: records the messages the loop sees on
   * step 0, then delegates to the underlying generate. Shared across tests.
   */
  function makeCapturingGenerate(text = 'done') {
    const capturedMessages: Array<{ role: string; content: unknown }> = [];
    const base = makeGenerate(text);
    type GenerateContext = Parameters<typeof base>[0];
    const capturingGenerate = async (context: GenerateContext) => {
      if (capturedMessages.length === 0) {
        for (const msg of context.conversation.getMessages()) {
          capturedMessages.push({ role: msg.role, content: msg.content });
        }
      }
      return base(context);
    };
    return { capturingGenerate, capturedMessages };
  }

  it('injects the skill catalog into the conversation on step 0', async () => {
    const mockProvider = {
      listSkills: async () => [
        { name: 'research', description: 'Research skills' },
        { name: 'writing', description: 'Writing skills' },
      ],
      isEnabled: async (_name: string) => true,
    };

    const { capturingGenerate, capturedMessages } = makeCapturingGenerate();
    const bureau = createBureau()
      .skills(mockProvider)
      .agent({ name: 'a', generate: capturingGenerate });

    await bureau.run('a', 'summarize').result();

    // At least one system message must contain the skill catalog.
    const systemMessages = capturedMessages.filter((m) => m.role === 'system');
    const catalogMessage = systemMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('<available_skills>'),
    );
    expect(catalogMessage).toBeDefined();

    const catalog = catalogMessage?.content as string;
    expect(catalog).toContain('research');
    expect(catalog).toContain('writing');
  });

  it('skill catalog respects denyList policy', async () => {
    const mockProvider = {
      listSkills: async () => [
        { name: 'research', description: 'Research skills' },
        { name: 'writing', description: 'Writing skills' },
      ],
      isEnabled: async (_name: string) => true,
    };

    const { capturingGenerate, capturedMessages } = makeCapturingGenerate();
    const bureau = createBureau()
      .skills(mockProvider, { denyList: ['writing'] })
      .agent({ name: 'a', generate: capturingGenerate });

    await bureau.run('a', 'input').result();

    const systemMessages = capturedMessages.filter((m) => m.role === 'system');
    const catalogMessage = systemMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('<available_skills>'),
    );
    expect(catalogMessage).toBeDefined();
    const catalog = catalogMessage?.content as string;
    expect(catalog).toContain('research');
    expect(catalog).not.toContain('writing');
  });

  it('intersects bureau and agent allowLists (agent cannot widen the bureau allowance)', async () => {
    // Regression PRRT_kwDORvupsc6MVia_: mergeSkillPolicies took the agent allowList
    // wholesale (`agent ?? bureau`) instead of intersecting. An agent could then
    // surface a skill the bureau never allowed. The bureau allows research+writing;
    // the agent allows writing+analysis. Only the intersection (writing) must appear —
    // analysis (agent-only) must NOT, and research (bureau-only) must NOT.
    const mockProvider = {
      listSkills: async () => [
        { name: 'research', description: 'Research skills' },
        { name: 'writing', description: 'Writing skills' },
        { name: 'analysis', description: 'Analysis skills' },
      ],
      isEnabled: async (_name: string) => true,
    };

    const { capturingGenerate, capturedMessages } = makeCapturingGenerate();
    const bureau = createBureau()
      .skills(mockProvider, { allowList: ['research', 'writing'] })
      .agent({
        name: 'a',
        generate: capturingGenerate,
        skillPolicy: { allowList: ['writing', 'analysis'] },
      });

    await bureau.run('a', 'input').result();

    const systemMessages = capturedMessages.filter((m) => m.role === 'system');
    const catalogMessage = systemMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('<available_skills>'),
    );
    expect(catalogMessage).toBeDefined();
    const catalog = catalogMessage?.content as string;
    expect(catalog).toContain('writing'); // allowed by BOTH
    expect(catalog).not.toContain('analysis'); // agent-only — must not be widened in
    expect(catalog).not.toContain('research'); // bureau-only — narrowed out by the agent
  });

  it('skips disabled skills from the catalog', async () => {
    const mockProvider = {
      listSkills: async () => [
        { name: 'research', description: 'Research skills' },
        { name: 'disabled-skill', description: 'A disabled skill' },
      ],
      isEnabled: async (name: string) => name !== 'disabled-skill',
    };

    const { capturingGenerate, capturedMessages } = makeCapturingGenerate();
    const bureau = createBureau()
      .skills(mockProvider)
      .agent({ name: 'a', generate: capturingGenerate });

    await bureau.run('a', 'input').result();

    const systemMessages = capturedMessages.filter((m) => m.role === 'system');
    const catalogMessage = systemMessages.find(
      (m) => typeof m.content === 'string' && m.content.includes('<available_skills>'),
    );
    expect(catalogMessage).toBeDefined();
    const catalog = catalogMessage?.content as string;
    expect(catalog).toContain('research');
    expect(catalog).not.toContain('disabled-skill');
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MXoT1 — builder run() omits agentName metadata
//
// The builder's run() path was building RunOptions without agentName or runId,
// so curated tool.* bubble events emitted by createActiveRun were stamped with
// empty strings instead of the resolved agent's name + a stable run id.
// ---------------------------------------------------------------------------

describe('createBureau (builder) — tool.* bubble event stamping (PRRT_kwDORvupsc6MXoT1)', () => {
  it('tool.started events carry the registered agent name in agentName', async () => {
    // A generate that fires one echo tool call on step 0, then text on step 1.
    const toolCallGenerate = createMockGenerate([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }],
      },
      { content: 'done', toolCalls: [] },
    ]);

    const bureau = createBureau()
      .tools({ echo: echoTool })
      .agent({ name: 'my-agent', generate: toolCallGenerate });

    const run = bureau.run('my-agent', 'say hello');

    // Collect tool.started events from the run's async iterator.
    const toolStartedEvents: ToolStartedBubbleEvent[] = [];
    for await (const event of run) {
      if (event.type === 'tool.started') {
        toolStartedEvents.push(event as ToolStartedBubbleEvent);
      }
    }

    expect(toolStartedEvents.length).toBeGreaterThanOrEqual(1);
    // Before the fix: agentName was '' (empty). After the fix: 'my-agent'.
    expect(toolStartedEvents[0]!.agentName).toBe('my-agent');
    // runId must be a non-empty string.
    expect(toolStartedEvents[0]!.runId).not.toBe('');
    expect(typeof toolStartedEvents[0]!.runId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Regression: PRRT_kwDORvupsc6MX3PQ / PRRT_kwDORvupsc6MYImo
//   mergeToolboxes() returned the stored bureau toolbox reference when only
//   one side (bureau OR agent) had tools. Two concurrent run() calls therefore
//   subscribed to the SAME CompletableEventTarget emitter, causing each run to
//   receive the other's tool events (cross-run event pollution).
//
// Fix: call .extend() on the single non-null toolbox so each run gets its own
//   fresh emitter, matching the pattern used by createRunRuntime() in
//   runtime-composition.ts.
// ---------------------------------------------------------------------------

describe('createBureau (builder) — toolbox isolation for concurrent runs (PRRT_kwDORvupsc6MX3PQ / PRRT_kwDORvupsc6MYImo)', () => {
  it('concurrent runs on a bureau-only toolbox each see only their own tool.started events', async () => {
    // Two distinct echo calls — run A uses {text:'alpha'}, run B uses {text:'beta'}.
    // If the toolbox emitter is shared, run A will see run B's tool.started (and vice versa).
    const generateA = createMockGenerate([
      { content: '', toolCalls: [{ name: 'echo', arguments: { text: 'alpha' } }] },
      { content: 'done-a', toolCalls: [] },
    ]);
    const generateB = createMockGenerate([
      { content: '', toolCalls: [{ name: 'echo', arguments: { text: 'beta' } }] },
      { content: 'done-b', toolCalls: [] },
    ]);

    // Both agents share bureau-level tools; neither has agent-level tools.
    // This exercises the single-sided path in mergeToolboxes().
    const bureau = createBureau()
      .tools({ echo: echoTool })
      .agent({ name: 'agent-a', generate: generateA })
      .agent({ name: 'agent-b', generate: generateB });

    const runA = bureau.run('agent-a', 'say alpha');
    const runB = bureau.run('agent-b', 'say beta');

    // Drain both runs concurrently, collecting tool.started events per run.
    const [eventsA, eventsB] = await Promise.all([
      (async () => {
        const collected: ToolStartedBubbleEvent[] = [];
        for await (const event of runA) {
          if (event.type === 'tool.started') collected.push(event as ToolStartedBubbleEvent);
        }
        return collected;
      })(),
      (async () => {
        const collected: ToolStartedBubbleEvent[] = [];
        for await (const event of runB) {
          if (event.type === 'tool.started') collected.push(event as ToolStartedBubbleEvent);
        }
        return collected;
      })(),
    ]);

    // Each run must see exactly one tool.started event (its own tool call).
    // Before the fix: the shared emitter routes both tools' events to both runs,
    // so each run sees 2 events (count > 1) and may see the other's params.
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);

    // The params in each run's event must match its own tool call, not the sibling's.
    expect((eventsA[0]!.params as { text: string }).text).toBe('alpha');
    expect((eventsB[0]!.params as { text: string }).text).toBe('beta');
  });
});
