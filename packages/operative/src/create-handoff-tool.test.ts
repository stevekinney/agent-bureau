import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { CompletableEventTarget } from 'lifecycle';
import { z } from 'zod';

import { stopWhen } from './conditions';
import type { RegistryAgent } from './create-agent-registry';
import { createHandoffTool, extractHandoffTarget, HANDOFF_MARKER } from './create-handoff-tool';
import type { CombinedOperativeEventMap } from './events';
import { HandoffOccurredEvent } from './events';
import { executeLoop } from './loop';
import type { GenerateFunction, RunResult } from './types';

function makeAgent(name: string): RegistryAgent {
  return {
    name,
    run: async () => ({
      conversation: {} as never,
      content: '',
      finishReason: 'end-turn',
      steps: [],
      usage: { prompt: 0, completion: 0, total: 0 },
    }),
  };
}

describe('createHandoffTool', () => {
  function makeEmitter() {
    return new CompletableEventTarget<CombinedOperativeEventMap>();
  }

  describe('basic behavior', () => {
    it('uses default name transfer_to_<agent>', () => {
      const tool = createHandoffTool({ agent: makeAgent('writer') });
      expect(tool.name).toBe('transfer_to_writer');
    });

    it('uses a custom name when provided', () => {
      const tool = createHandoffTool({ agent: makeAgent('writer'), name: 'handoff_to_writer' });
      expect(tool.name).toBe('handoff_to_writer');
    });

    it('returns a JSON result with HANDOFF_MARKER type and agent name', async () => {
      const tool = createHandoffTool({ agent: makeAgent('writer') });
      const result = JSON.parse(await tool.execute({})) as { type: string; agent: string };
      expect(result.type).toBe(HANDOFF_MARKER);
      expect(result.agent).toBe('writer');
    });
  });

  describe('F2 / C3 — HandoffOccurredEvent emission', () => {
    it('dispatches HandoffOccurredEvent when sourceContext is provided', async () => {
      const emitter = makeEmitter();
      const received: HandoffOccurredEvent[] = [];

      emitter.addEventListener(HandoffOccurredEvent.type, (event) => {
        received.push(event);
      });

      const tool = createHandoffTool({
        agent: makeAgent('writer'),
        sourceContext: {
          emitter,
          sourceAgentName: 'orchestrator',
        },
      });

      await tool.execute({});

      expect(received).toHaveLength(1);
    });

    it('emits correct sourceAgentName and targetAgentName', async () => {
      const emitter = makeEmitter();
      const received: HandoffOccurredEvent[] = [];

      emitter.addEventListener(HandoffOccurredEvent.type, (event) => {
        received.push(event);
      });

      const tool = createHandoffTool({
        agent: makeAgent('writer'),
        sourceContext: {
          emitter,
          sourceAgentName: 'orchestrator',
        },
      });

      await tool.execute({});

      const event = received[0];
      expect(event?.sourceAgentName).toBe('orchestrator');
      expect(event?.targetAgentName).toBe('writer');
    });

    it('includes sessionId in the event when provided (F2 durable session-continuation)', async () => {
      const emitter = makeEmitter();
      let capturedSessionId: string | undefined;

      emitter.addEventListener(HandoffOccurredEvent.type, (event) => {
        capturedSessionId = event.sessionId;
      });

      const tool = createHandoffTool({
        agent: makeAgent('writer'),
        sourceContext: {
          emitter,
          sourceAgentName: 'orchestrator',
          sessionId: 'session-abc',
        },
      });

      await tool.execute({});

      expect(capturedSessionId).toBe('session-abc');
    });

    it('emits event with undefined sessionId when not provided', async () => {
      const emitter = makeEmitter();
      let capturedSessionId: string | undefined = 'was-set';

      emitter.addEventListener(HandoffOccurredEvent.type, (event) => {
        capturedSessionId = event.sessionId;
      });

      const tool = createHandoffTool({
        agent: makeAgent('writer'),
        sourceContext: {
          emitter,
          sourceAgentName: 'orchestrator',
        },
      });

      await tool.execute({});

      expect(capturedSessionId).toBeUndefined();
    });

    it('does not emit any event when sourceContext is not provided', async () => {
      const emitter = makeEmitter();
      const received: HandoffOccurredEvent[] = [];

      emitter.addEventListener(HandoffOccurredEvent.type, (event) => {
        received.push(event);
      });

      const tool = createHandoffTool({ agent: makeAgent('writer') });
      await tool.execute({});

      expect(received).toHaveLength(0);
    });
  });
});

describe('extractHandoffTarget', () => {
  it('returns undefined when there are no steps', () => {
    expect(extractHandoffTarget([])).toBeUndefined();
  });

  it('returns the agent name from the last step HANDOFF_MARKER', () => {
    const steps = [
      { results: [{ content: JSON.stringify({ type: HANDOFF_MARKER, agent: 'writer' }) }] },
    ];
    expect(extractHandoffTarget(steps)).toBe('writer');
  });

  it('returns undefined when the last step has no HANDOFF_MARKER', () => {
    const steps = [{ results: [{ content: 'Not a handoff result' }] }];
    expect(extractHandoffTarget(steps)).toBeUndefined();
  });

  it('uses only the LAST step for extraction', () => {
    const steps = [
      { results: [{ content: JSON.stringify({ type: HANDOFF_MARKER, agent: 'first' }) }] },
      { results: [{ content: 'No handoff here' }] },
    ];
    // last step has no handoff
    expect(extractHandoffTarget(steps)).toBeUndefined();
  });
});

describe('stop conditions around a handoff (AB-149)', () => {
  // A handoff whose arguments fail schema validation still produces a tool CALL, so
  // `stopWhen.toolCalled(name)` — which inspects `context.toolCalls` and never
  // `context.results` — fires anyway and ends the run with no HANDOFF_MARKER. These
  // tests pin the behavior the README documents.
  const HANDOFF_NAME = 'escalate-to-support';

  function makeHandoffToolbox() {
    return createToolbox([
      createHandoffTool({
        name: HANDOFF_NAME,
        agent: makeAgent('support'),
        input: z.object({ reason: z.string() }),
      }),
    ]);
  }

  /**
   * `ToolExecutionResult.content` is the wider `JSONValue`, but every tool built with
   * `createTool()` resolves to a string, so the string branch is the real path here.
   */
  function contentAsString(content: unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  /** Narrows `RunResult.steps` to the `{ content: string }` shape extractHandoffTarget expects. */
  function targetOf(result: RunResult): string | undefined {
    return extractHandoffTarget(
      result.steps.map((step) => ({
        results: step.results.map((toolResult) => ({
          content: contentAsString(toolResult.content),
        })),
      })),
    );
  }

  /** Emits the given tool calls one step at a time, then plain text forever after. */
  function generateSteps(
    ...perStepToolCalls: { name: string; arguments: unknown }[][]
  ): GenerateFunction {
    let step = 0;
    return async () => ({ content: 'ok', toolCalls: perStepToolCalls[step++] ?? [] });
  }

  it('stopWhen.toolCalled fires on a FAILED handoff, leaving extractHandoffTarget undefined', async () => {
    const result = await executeLoop({
      generate: generateSteps([{ name: HANDOFF_NAME, arguments: 'just a bare string' }]),
      toolbox: makeHandoffToolbox(),
      conversation: new Conversation(),
      maximumSteps: 3,
      stopWhen: stopWhen.toolCalled(HANDOFF_NAME),
    });

    // The loop stopped on the call name alone...
    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(1);
    // ...but the tool errored before reaching execute, so no marker was ever produced.
    expect(result.steps[0]?.results[0]?.outcome).toBe('error');
    expect(targetOf(result)).toBeUndefined();
  });

  it('the every/not composition skips a failed handoff and stops on a later successful one', async () => {
    const result = await executeLoop({
      generate: generateSteps(
        [{ name: HANDOFF_NAME, arguments: 'just a bare string' }],
        [{ name: HANDOFF_NAME, arguments: { reason: 'needs a human' } }],
      ),
      toolbox: makeHandoffToolbox(),
      conversation: new Conversation(),
      maximumSteps: 3,
      stopWhen: stopWhen.every(
        stopWhen.toolCalled(HANDOFF_NAME),
        stopWhen.not(stopWhen.toolOutcome('error')),
      ),
    });

    expect(result.finishReason).toBe('stop-condition');
    // Step 0's failed handoff did not stop the loop; step 1's valid one did.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.results[0]?.outcome).toBe('error');
    expect(result.steps[1]?.results[0]?.outcome).toBe('success');
    expect(targetOf(result)).toBe('support');
  });

  it('the README array form bounds a handoff the model never gets right', async () => {
    // Mirrors the README recommendation exactly: the composition OR a step cap. Stop conditions
    // in an array are OR-ed, so the cap is what terminates a handoff that never validates.
    const result = await executeLoop({
      generate: generateSteps(
        [{ name: HANDOFF_NAME, arguments: 'bad' }],
        [{ name: HANDOFF_NAME, arguments: 'still bad' }],
        [{ name: HANDOFF_NAME, arguments: 'bad again' }],
      ),
      toolbox: makeHandoffToolbox(),
      conversation: new Conversation(),
      maximumSteps: 10,
      stopWhen: [
        stopWhen.every(
          stopWhen.toolCalled(HANDOFF_NAME),
          stopWhen.not(stopWhen.toolOutcome('error')),
        ),
        stopWhen.maximumSteps(3),
      ],
    });

    // The composition never fired; the cap ended the run at 3 steps with no transfer.
    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(3);
    expect(targetOf(result)).toBeUndefined();
  });

  it('records validated custom input on the step toolCalls, not in the handoff marker', async () => {
    const result = await executeLoop({
      generate: generateSteps([{ name: HANDOFF_NAME, arguments: { reason: 'needs a human' } }]),
      toolbox: makeHandoffToolbox(),
      conversation: new Conversation(),
      maximumSteps: 3,
      stopWhen: stopWhen.toolCalled(HANDOFF_NAME),
    });

    // The marker carries only type + agent — `reason` is absent from it.
    const marker = JSON.parse(contentAsString(result.steps[0]?.results[0]?.content)) as Record<
      string,
      unknown
    >;
    expect(marker).toEqual({ type: HANDOFF_MARKER, agent: 'support' });

    // The reason is recoverable from the recorded tool CALL instead. This mirrors the exact
    // recovery snippet in the README so the documented shape stays honest.
    const handoffCall = result.steps
      .flatMap((step) => step.toolCalls)
      .find((call) => call.name === HANDOFF_NAME);
    const reason =
      handoffCall && z.object({ reason: z.string() }).parse(handoffCall.arguments).reason;

    expect(reason).toBe('needs a human');
  });
});
