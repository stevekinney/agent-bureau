import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { materializeToolCalls } from 'interoperability';
import { z } from 'zod';

import type { DurableRunDeps } from './deps-registry';
import { clearRunDeps, registerRunDeps, resetRunDepsRegistry } from './deps-registry';
import { executeToolActivity, toDurableToolResult } from './execute-tool-activity';

// `Toolbox`'s tool-tuple generic is invariant, so a concretely-typed toolbox is
// not directly assignable to the registry's `Toolbox<any>`. The durable layer
// never inspects the tuple type; this cast matches gateway's test convention.
type RegistryToolbox = DurableRunDeps['toolbox'];

const echoTool = createTool({
  name: 'echo',
  description: 'Echoes its message back',
  input: z.object({ message: z.string() }),
  execute: async ({ message }) => ({ echoed: message }),
});

function makeToolbox(): RegistryToolbox {
  return createToolbox([echoTool]) as RegistryToolbox;
}

function materialize(name: string, args: Record<string, unknown>) {
  const [call] = materializeToolCalls([{ name, arguments: args }]);
  return call!;
}

/**
 * Await a promise expected to reject and return the thrown error. Used instead
 * of `expect(...).rejects` because `activity().execute` is typed sync-or-async,
 * which trips `await-thenable` under src-level type-aware lint.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected promise to reject, but it resolved');
}

afterEach(() => {
  resetRunDepsRegistry();
});

describe('executeToolActivity', () => {
  it('executes the tool through the run toolbox resolved from the deps registry', async () => {
    const toolbox = makeToolbox();
    registerRunDeps('run-1', { toolbox, options: {} as never });

    const toolCall = materialize('echo', { message: 'hello' });
    const result = await executeToolActivity.execute({ runId: 'run-1', toolCall });

    expect(result.outcome).toBe('success');
    expect(result.content).toEqual({ echoed: 'hello' });
    expect(result.toolName).toBe('echo');
    expect(result.callId).toBe(toolCall.id);
  });

  it('produces the same content as a direct toolbox.execute call (round-trip fidelity)', async () => {
    const toolbox = makeToolbox();
    registerRunDeps('run-1', { toolbox, options: {} as never });

    const toolCall = materialize('echo', { message: 'fidelity' });

    const direct = await toolbox.execute(toolCall);
    const viaActivity = await executeToolActivity.execute({ runId: 'run-1', toolCall });

    // The activity projection keeps the JSON-safe subset identically.
    expect(viaActivity).toEqual(toDurableToolResult(direct));
    expect(viaActivity.content).toEqual(direct.content);
    expect(viaActivity.outcome).toBe(direct.outcome);
  });

  it('returns a structuredClone-safe projection (no stream, no unknown result handle)', async () => {
    const toolbox = makeToolbox();
    registerRunDeps('run-1', { toolbox, options: {} as never });

    const toolCall = materialize('echo', { message: 'cloneable' });
    const result = await executeToolActivity.execute({ runId: 'run-1', toolCall });

    // Must survive structuredClone — this is the checkpoint serializability contract.
    expect(() => structuredClone(result)).not.toThrow();
    expect('stream' in result).toBe(false);
  });

  it('throws a descriptive error when the run has no registered deps (recovery gap, made loud)', async () => {
    const toolCall = materialize('echo', { message: 'orphan' });
    const error = await captureRejection(
      Promise.resolve(executeToolActivity.execute({ runId: 'never-registered', toolCall })),
    );
    expect((error as Error).message).toMatch(/No durable run deps registered/);
  });

  it('surfaces a tool error as an error-outcome projection', async () => {
    const explode = createTool({
      name: 'explode',
      description: 'Always throws',
      input: z.object({}),
      execute: async () => {
        throw new Error('boom');
      },
    });
    registerRunDeps('run-err', {
      toolbox: createToolbox([explode]) as RegistryToolbox,
      options: {} as never,
    });

    const toolCall = materialize('explode', {});
    const result = await executeToolActivity.execute({ runId: 'run-err', toolCall });

    expect(result.outcome).toBe('error');
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('is marked idempotent and named for stable registration', () => {
    expect(executeToolActivity.name).toBe('executeTool');
    expect(executeToolActivity.idempotent).toBe(true);
  });

  it('clearRunDeps removes a run so subsequent execution throws', async () => {
    registerRunDeps('run-1', { toolbox: makeToolbox(), options: {} as never });
    clearRunDeps('run-1');
    const toolCall = materialize('echo', { message: 'gone' });
    const error = await captureRejection(
      Promise.resolve(executeToolActivity.execute({ runId: 'run-1', toolCall })),
    );
    expect((error as Error).message).toMatch(/No durable run deps registered/);
  });
});
