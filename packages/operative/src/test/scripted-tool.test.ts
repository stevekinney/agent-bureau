import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createManualRuntimeServices, HookRegistry } from 'lifecycle';

import { noToolCalls } from '../conditions/predicates';
import { createActiveRun } from '../create-run';
import type { CombinedOperativeEventClassMap } from '../events';
import type { OperativeHookMap } from '../hooks';
import type { GenerateResponse } from '../types';
import { createEventRecorder } from './event-recorder';
import { createScriptedGenerate } from './scripted-generate';
import { createScriptedHook, createScriptedTool } from './scripted-tool';

/**
 * Drives a `ScriptedTool` through a real `Toolbox.execute()` — the actual
 * public entry point, not the internal `Tool.run(params, context)` armorer
 * reserves for its own execution machinery (that `context` parameter is a
 * fully-populated `RuntimeToolContext` a test author cannot hand-construct).
 */
function executeTool(
  tool: ReturnType<typeof createScriptedTool>,
  callId: string,
  args: Record<string, unknown> = {},
) {
  const toolbox = createToolbox([tool]);
  return toolbox.execute([{ id: callId, name: tool.name, arguments: args }]);
}

describe('createScriptedTool', () => {
  it('records calls and resolves with the scripted result', async () => {
    const tool = createScriptedTool('echo', [{ kind: 'resolve', result: 'ok' }]);
    const [result] = await executeTool(tool, 'call-1', { input: 'hi' });

    expect(result?.outcome).toBe('success');
    expect(result?.result).toBe('ok');
    expect(tool.callCount).toBe(1);
    expect(tool.calls[0]?.params).toEqual({ input: 'hi' });
  });

  it('rejects with the scripted error, surfaced as an error-outcome result', async () => {
    const tool = createScriptedTool('boom', [{ kind: 'reject', error: new Error('nope') }]);
    const [result] = await executeTool(tool, 'call-1');

    expect(result?.outcome).toBe('error');
    expect(result?.error?.message).toContain('nope');
  });

  it('blocks until release, then consumes the next step', async () => {
    const tool = createScriptedTool('gated', [
      { kind: 'block', barrier: 'gate' },
      { kind: 'resolve', result: 'unblocked' },
    ]);

    const callPromise = executeTool(tool, 'call-1');
    await tool.reached('gate');

    let settled = false;
    void callPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    tool.release('gate');
    const [result] = await callPromise;

    expect(result?.result).toBe('unblocked');
  });

  it('rejects the second call rather than deadlocking when two concurrent calls arrive at the same block barrier name (regression: PR #519 review)', async () => {
    // `Toolbox.execute()` runs the two calls below in parallel: the first
    // call's own `block`/reserve-next protocol consumes indices 0 and 1
    // before the second call starts, so index 2's `block` is the second
    // call's OWN step — a second, genuinely concurrent arrival at the same
    // "gate" name while the first arrival is still awaiting release.
    const tool = createScriptedTool('gated', [
      { kind: 'block', barrier: 'gate' },
      { kind: 'resolve', result: 'first' },
      { kind: 'block', barrier: 'gate' },
      { kind: 'resolve', result: 'second' },
    ]);
    const toolbox = createToolbox([tool]);

    const executePromise = toolbox.execute([
      { id: 'call-1', name: 'gated', arguments: {} },
      { id: 'call-2', name: 'gated', arguments: {} },
    ]);
    await tool.reached('gate');

    tool.release('gate');
    const results = await executePromise;

    const succeeded = results.find((result) => result.outcome === 'success');
    const errored = results.find((result) => result.outcome === 'error');
    expect(succeeded?.result).toBe('first');
    expect(errored?.error?.message).toContain(
      'arrive("gate") called while a previous arrival at "gate" is still awaiting release',
    );
  });

  describe('settled()', () => {
    it('resolves once every call so far has settled, including a rejected one', async () => {
      const tool = createScriptedTool('mixed', [
        { kind: 'resolve', result: 'first' },
        { kind: 'reject', error: new Error('second failed') },
      ]);

      // The toolbox itself absorbs the rejection into an error-outcome
      // result rather than propagating it — `settled()` is what proves
      // the double's own step actually rejected underneath.
      await executeTool(tool, 'call-1');
      await executeTool(tool, 'call-2');

      const settlements = await tool.settled();
      expect(settlements).toEqual([
        { index: 0, outcome: 'resolved', value: 'first' },
        {
          index: 1,
          outcome: 'rejected',
          error: expect.objectContaining({ message: 'second failed' }),
        },
      ]);
    });

    it('resolves with an empty list when no call has been made', async () => {
      const tool = createScriptedTool('unused', []);
      expect(await tool.settled()).toEqual([]);
    });
  });
});

describe('createScriptedHook', () => {
  it('records calls and resolves with the scripted value', async () => {
    const hook = createScriptedHook('after-tool', [{ kind: 'resolve', value: undefined }]);

    await hook({
      conversation: new Conversation(),
      step: 0,
      toolCalls: [],
      results: [],
    });

    expect(hook.callCount).toBe(1);
    expect(hook.hookName).toBe('afterToolExecution');
  });

  it('rejects with the scripted error', async () => {
    const hook = createScriptedHook('after-tool', [{ kind: 'reject', error: new Error('denied') }]);

    expect(
      hook({ conversation: new Conversation(), step: 0, toolCalls: [], results: [] }),
    ).rejects.toThrow('denied');
  });

  it('maps each phase to its OperativeHookMap key', () => {
    expect(createScriptedHook('before-model', []).hookName).toBe('beforeGenerate');
    expect(createScriptedHook('after-model', []).hookName).toBe('afterGenerate');
    expect(createScriptedHook('before-tool', []).hookName).toBe('beforeToolExecution');
    expect(createScriptedHook('after-tool', []).hookName).toBe('afterToolExecution');
  });

  it('records the call in .calls', async () => {
    const hook = createScriptedHook('after-tool', [{ kind: 'resolve', value: undefined }]);
    const context = { conversation: new Conversation(), step: 0, toolCalls: [], results: [] };

    await hook(context);

    expect(hook.calls).toEqual([{ context }]);
  });

  describe('settled()', () => {
    it('resolves once every call so far has settled, including a rejected one', async () => {
      const hook = createScriptedHook('after-tool', [
        { kind: 'resolve', value: undefined },
        { kind: 'reject', error: new Error('rejected') },
      ]);
      const context = { conversation: new Conversation(), step: 0, toolCalls: [], results: [] };

      await hook(context);
      // Attach a rejection handler synchronously so this is not an
      // unhandled rejection — `settled()` is what proves the double's own
      // step actually rejected underneath.
      await hook(context).catch(() => undefined);

      expect(await hook.settled()).toEqual([
        { index: 0, outcome: 'resolved', value: undefined },
        {
          index: 1,
          outcome: 'rejected',
          error: expect.objectContaining({ message: 'rejected' }),
        },
      ]);
    });
  });
});

describe('barrier-coordination contract', () => {
  it('composes a scripted generate, tool, and hook through a real run, each blocking at its own barrier, releasable in any order', async () => {
    const runtime = createManualRuntimeServices();

    const toolCallResponse: GenerateResponse = {
      content: '',
      toolCalls: [{ id: 'call-1', name: 'search', arguments: { query: 'gate' } }],
    };
    const finalResponse: GenerateResponse = { content: 'done', toolCalls: [] };

    const generate = createScriptedGenerate([
      { kind: 'block', barrier: 'generate-gate' },
      { kind: 'respond', response: toolCallResponse },
      { kind: 'respond', response: finalResponse },
    ]);

    const searchTool = createScriptedTool('search', [
      { kind: 'block', barrier: 'tool-gate' },
      { kind: 'resolve', result: 'search results' },
    ]);

    const afterToolHook = createScriptedHook('after-tool', [
      { kind: 'block', barrier: 'hook-gate' },
      { kind: 'resolve', value: undefined },
    ]);

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on(afterToolHook.hookName, afterToolHook);

    const toolbox = createToolbox([searchTool]);
    const conversation = new Conversation();

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
      hooks,
      runtime,
    });

    const recorder = createEventRecorder(runtime);
    recorder.attach<CombinedOperativeEventClassMap>(activeRun, { kind: 'run', id: 'contract-run' });

    // Released in a deliberately non-causal order, before any of them has
    // necessarily arrived — proving `release` is a latch, not a rendezvous
    // that requires the releaser to already be waiting.
    searchTool.release('tool-gate');
    afterToolHook.release('hook-gate');
    generate.release('generate-gate');

    await Promise.all([
      generate.reached('generate-gate'),
      searchTool.reached('tool-gate'),
      afterToolHook.reached('hook-gate'),
    ]);

    const result = await activeRun.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('done');
    expect(generate.callCount).toBe(2);
    expect(searchTool.callCount).toBe(1);
    expect(afterToolHook.callCount).toBe(1);

    const trace = recorder.normalize();
    const indexOf = (event: string): number => trace.findIndex((entry) => entry.event === event);

    // The causal event sequence this composition forces: the first generate
    // call completes before tools execute; tools execute before they
    // finish; tools finish before the second generate call starts; that
    // second call is the one that ends the run.
    expect(indexOf('generate.completed')).toBeGreaterThanOrEqual(0);
    expect(indexOf('tools.executing')).toBeGreaterThan(indexOf('generate.completed'));
    expect(indexOf('tools.executed')).toBeGreaterThan(indexOf('tools.executing'));
    expect(trace.filter((entry) => entry.event === 'generate.started')).toHaveLength(2);
    expect(indexOf('run.completed')).toBe(trace.length - 1);
  });
});
