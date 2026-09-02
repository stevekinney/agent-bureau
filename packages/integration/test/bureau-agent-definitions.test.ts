/**
 * AB-23 — repository-native integration coverage for Bureau's typed
 * `AgentDefinitions` catalog (AB-15/AB-22): direct, barrel, dynamic
 * (createLazyAgent + a real dynamic import), and createLazyGenerate agent
 * definitions in one catalog; `bureau.run(name, input)`'s synchronous,
 * non-thenable return; and literal-name output inference versus a genuinely
 * widened (union) name.
 *
 * Every agent here uses a hand-rolled deterministic `GenerateFunction` —
 * no provider SDK, network call, or credential.
 */
import * as operative from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import type { AgentRunForName, Bureau } from 'bureau';
import { createBureau } from 'bureau';
import { z } from 'zod';

import { echoOutputSchema } from './fixtures/bureau-lazy-agent-module';

const greetingOutputSchema = z.object({ greeting: z.string() });

function deterministicGenerate(reply: unknown) {
  return async () => ({
    content: JSON.stringify(reply),
    toolCalls: [],
    usage: { prompt: 4, completion: 4, total: 8 },
  });
}

// Direct definition.
function buildDirectAgent() {
  return operative.createAgent({
    name: 'direct-agent',
    generate: deterministicGenerate({ greeting: 'hello from direct' }),
    instructions: 'You are a deterministic greeter.',
    output: greetingOutputSchema,
    stopWhen: (context) => context.step >= 1,
  });
}

// Barrel definition — built through `import * as operative` rather than a
// named `createAgent` import, and with no `output` schema at all (H = false).
function buildBarrelAgent() {
  return operative.createAgent({
    name: 'barrel-agent',
    generate: async () => ({ content: 'plain text from barrel agent', toolCalls: [] }),
    instructions: 'You reply with plain text.',
    stopWhen: (context) => context.step >= 1,
  });
}

// Dynamic definition — createLazyAgent over a real dynamic import of a
// separate module (bureau-lazy-agent-module.ts).
function buildDynamicAgent() {
  return operative.createLazyAgent(() =>
    import('./fixtures/bureau-lazy-agent-module').then((module) => module.default),
  );
}

// createLazyGenerate definition — the GenerateFunction, not the agent, is
// lazily loaded.
async function loadLazyGenerate(): Promise<operative.GenerateFunction> {
  return deterministicGenerate({ greeting: 'hello from lazy generate' });
}
function buildLazyGenerateAgent() {
  return operative.createAgent({
    name: 'lazy-generate-agent',
    generate: operative.createLazyGenerate(() => loadLazyGenerate()),
    instructions: 'You are a deterministic greeter loaded through createLazyGenerate.',
    output: greetingOutputSchema,
    stopWhen: (context) => context.step >= 1,
  });
}

const agents = {
  direct: buildDirectAgent(),
  barrel: buildBarrelAgent(),
  dynamic: buildDynamicAgent(),
  lazyGenerate: buildLazyGenerateAgent(),
};

type Agents = typeof agents;

async function makeBureau(): Promise<Bureau<Agents>> {
  return createBureau({ agents });
}

describe('Bureau direct, barrel, dynamic, and lazy agent definitions', () => {
  it('runs a directly-defined catalog agent to completion', async () => {
    const bureau = await makeBureau();
    try {
      const result = await bureau.run('direct', 'hi').result();
      expect(result.finishReason).toBe('stop-condition');
      expect(result.output).toEqual({ greeting: 'hello from direct' });
    } finally {
      bureau.dispose();
    }
  });

  it('runs a barrel-imported catalog agent (no output schema) to completion', async () => {
    const bureau = await makeBureau();
    try {
      const result = await bureau.run('barrel', 'hi').result();
      expect(result.finishReason).toBe('stop-condition');
      expect(result.content).toContain('plain text from barrel agent');
    } finally {
      bureau.dispose();
    }
  });

  it('runs a dynamically-loaded (createLazyAgent + real import()) catalog agent to completion', async () => {
    const bureau = await makeBureau();
    try {
      const result = await bureau.run('dynamic', 'hi').result();
      expect(result.finishReason).toBe('stop-condition');
      expect(echoOutputSchema.parse(result.output)).toEqual({
        echoed: 'from the lazily-loaded module',
      });
    } finally {
      bureau.dispose();
    }
  });

  it('runs a catalog agent whose GenerateFunction is loaded through createLazyGenerate', async () => {
    const bureau = await makeBureau();
    try {
      const result = await bureau.run('lazyGenerate', 'hi').result();
      expect(result.finishReason).toBe('stop-condition');
      expect(result.output).toEqual({ greeting: 'hello from lazy generate' });
    } finally {
      bureau.dispose();
    }
  });
});

describe("bureau.run's synchronous, non-thenable return", () => {
  it('returns the AgentRun handle synchronously — no await needed to obtain it', async () => {
    const bureau = await makeBureau();
    try {
      // No `await` here: if `bureau.run` returned a Promise, `handle` would
      // be a Promise object rather than an AgentRun, and `.result` (a
      // method, not a field) would be undefined on it.
      const handle = bureau.run('direct', 'hi');
      expect(typeof handle.result).toBe('function');
      // Non-thenable by design (AB-15): `handle` must not expose `.then`,
      // so `await handle` is a type error and `Promise.resolve(handle)`
      // never silently unwraps it.
      expect(Reflect.has(handle, 'then')).toBe(false);
      const result = await handle.result();
      expect(result.finishReason).toBe('stop-condition');
    } finally {
      bureau.dispose();
    }
  });
});

describe('literal-name output inference and widened-name behavior', () => {
  it('infers the exact per-agent output type for a literal name', async () => {
    const bureau = await makeBureau();
    try {
      const directRun = bureau.run('direct', 'hi');
      // Literal name — TypeScript infers AgentRunForName<Agents, 'direct'>,
      // i.e. AgentRun<{greeting: string}, true>: .output() exists and is
      // typed as Promise<{greeting: string}>.
      const output: { greeting: string } = await directRun.output();
      expect(output).toEqual({ greeting: 'hello from direct' });

      const barrelRun = bureau.run('barrel', 'hi');
      // 'barrel' has no output schema (H = false) — .output() must not
      // exist on this handle's type at all.
      // @ts-expect-error — an untyped catalog agent's run handle has no .output() accessor.
      void barrelRun.output;
      await barrelRun.result();
    } finally {
      bureau.dispose();
    }
  });

  it('dispatches correctly and types as a proper union for a genuinely widened name', async () => {
    const bureau = await makeBureau();
    try {
      // A real widened name: a union of two literal keys, not narrowed to
      // one — the shape a caller reading a name off an HTTP path segment
      // (validated against bureau.agents.names()) would have.
      function pick(flag: boolean): 'direct' | 'lazyGenerate' {
        return flag ? 'direct' : 'lazyGenerate';
      }
      const widenedName = pick(true);

      const widenedRun = bureau.run(widenedName, 'hi');
      // The return type here is the DISTRIBUTED union
      // AgentRunForName<Agents, 'direct'> | AgentRunForName<Agents, 'lazyGenerate'>
      // — both branches happen to have H = true here, so this compiles;
      // the point of this assignment is that it would NOT compile if the
      // conditional type incorrectly collapsed to a non-distributed
      // AgentRun<unknown, boolean> for a widened name (see agent-catalog.ts's
      // "TName extends TName ? ... : never" doc comment).
      const typed: AgentRunForName<Agents, 'direct' | 'lazyGenerate'> = widenedRun;
      const result = await typed.result();
      expect(result.finishReason).toBe('stop-condition');
      // Runtime dispatch: the widened name still resolves to the correct
      // agent (the 'direct' branch, since pick(true) was called).
      expect(result.output).toEqual({ greeting: 'hello from direct' });
    } finally {
      bureau.dispose();
    }
  });
});
