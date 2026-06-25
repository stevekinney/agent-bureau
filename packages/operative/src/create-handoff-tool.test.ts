import { describe, expect, it } from 'bun:test';
import { CompletableEventTarget } from 'lifecycle';

import type { RegistryAgent } from './create-agent-registry';
import { createHandoffTool, extractHandoffTarget, HANDOFF_MARKER } from './create-handoff-tool';
import type { CombinedOperativeEventMap } from './events';
import { HandoffOccurredEvent } from './events';

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
