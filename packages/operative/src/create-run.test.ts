import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import { createMockGenerate } from './test/index';
import type { GenerateResponse } from './types';

/**
 * AB-204: `ActiveRun.closed()` — the cleanup acknowledgement. Colocated with
 * `create-run.ts` per this issue's Coordinator ruling on test file location.
 */

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('ActiveRun.closed()', () => {
  it('resolves { status: "completed" } once the result promise settles normally', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Call closed() before the run settles, so the not-required fast path
    // (first-call-already-terminal) does not apply — this exercises the
    // general "await the drain" path AC1 describes.
    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });

  it('resolves { status: "not-required" } immediately when first called after the run already settled with nothing tracked in flight', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    await activeRun.result;
    // Give closed()'s internal settlement tracker a turn to observe it.
    await Promise.resolve();

    expect(await activeRun.closed()).toEqual({ status: 'not-required' });
  });

  it('does not resolve not-required when closed() is first called before the run settles', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const pending = activeRun.closed();
    await activeRun.result;

    expect(await pending).toEqual({ status: 'completed' });
  });

  it('disqualifies the not-required fast path once abort() has been called, even after the run settles', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const generate = createMockGenerate([textResponse('should not run')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
    });
    activeRun.abort('cancelled');

    const result = await activeRun.result;
    expect(result.finishReason).toBe('aborted');
    await Promise.resolve();

    expect(await activeRun.closed()).toEqual({ status: 'completed' });
  });

  it('calling closed() twice after settlement returns the identical object by reference', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const first = await activeRun.closed();
    const second = await activeRun.closed();
    expect(second).toBe(first);
  });

  it('resolves { status: "unresolved", reason: "timed-out" } for a call whose own signal fires before settlement, while a concurrent signal-free call still observes the real settlement', async () => {
    let releaseGenerate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGenerate = resolve));
    const generate = async (): Promise<GenerateResponse> => {
      await gate;
      return textResponse('done');
    };
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const controller = new AbortController();
    const timedOutCall = activeRun.closed({ signal: controller.signal });
    const signalFreeCall = activeRun.closed();

    controller.abort();
    expect(await timedOutCall).toEqual({ status: 'unresolved', reason: 'timed-out' });

    releaseGenerate();
    const real = await signalFreeCall;
    expect(real).toEqual({ status: 'completed' });

    // A later call observes the identical cached settlement, never the
    // abandoned wait's outcome.
    expect(await activeRun.closed()).toBe(real);
  });

  it('resolves { status: "unresolved", reason: "timed-out" } immediately for an already-aborted signal', async () => {
    const generate = createMockGenerate([textResponse('done')]);
    const toolbox = createTestToolbox([]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const controller = new AbortController();
    controller.abort();
    expect(await activeRun.closed({ signal: controller.signal })).toEqual({
      status: 'unresolved',
      reason: 'timed-out',
    });

    await activeRun.result;
  });

  it('classifies a genuine rejection of the result promise as { status: "failed" }', async () => {
    const failure = new Error('toolbox cleanup listener threw');
    const generate = createMockGenerate([textResponse('done')]);
    // A toolbox whose `toObservable()`/`addEventListener()` satisfy the
    // forwarding this module wires up, but whose `execute-start` cleanup
    // throws — forcing `complete()` (run inside `.finally()`) to throw,
    // which rejects the public `result` promise. This is the one path that
    // exercises closed()'s `failed` classification for the in-memory loop,
    // which otherwise always resolves `result` (never rejects it).
    const toolbox = {
      toObservable: () => ({ subscribe: () => ({ unsubscribe(): void {}, closed: false }) }),
      addEventListener: () => () => {
        throw failure;
      },
    } as unknown as ReturnType<typeof createTestToolbox>;
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const closedAcknowledgement = activeRun.closed();
    let rejection: unknown;
    try {
      await activeRun.result;
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBe(failure);
    expect(await closedAcknowledgement).toEqual({ status: 'failed', error: failure });
  });

  it('tracks a real tool call through execute-start/settled without breaking the completed classification', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('done'),
    ]);
    const toolbox = createTestToolbox([weatherTool]);
    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const closedAcknowledgement = activeRun.closed();
    const result = await activeRun.result;
    expect(result.finishReason).toBe('stop-condition');
    expect(await closedAcknowledgement).toEqual({ status: 'completed' });
  });
});
