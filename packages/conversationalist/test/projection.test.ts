import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  type ConversationEnvironment,
  createConversationHistory,
  getMessages,
} from '../src/conversation/index';
import { createProjection, isProjectionPrefixExtension } from '../src/projection';
import {
  appendUnsafeStreamingMessage,
  cancelStreamingMessage,
  finalizeUnsafeStreamingMessage,
  updateUnsafeStreamingMessage,
} from '../src/streaming';
import type { ConversationHistory } from '../src/types';

type TranscriptEvent =
  | { id: string; kind: 'user.message'; content: string }
  | { id: string; kind: 'assistant.delta'; delta: string }
  | { id: string; kind: 'assistant.done' }
  | { id: string; kind: 'assistant.interrupted' }
  | {
      id: string;
      kind: 'tool.call';
      callId: string;
      name: string;
      arguments: Record<string, string>;
    }
  | { id: string; kind: 'tool.result'; callId: string; content: string };

type ProjectionState = {
  assistantMessageId?: string;
  assistantText: string;
  environment: Partial<ConversationEnvironment>;
};

const createTestEnvironment = (): Partial<ConversationEnvironment> => {
  let counter = 0;
  return {
    now: () => '2026-01-01T00:00:00.000Z',
    randomId: () => `projection-test-${++counter}`,
  };
};

const createSeed = (): ConversationHistory =>
  createConversationHistory({ id: 'projection-test' }, createTestEnvironment());

const initialState = (): ProjectionState => ({
  assistantText: '',
  environment: createTestEnvironment(),
});

const clearAssistantState = (state: ProjectionState): ProjectionState => ({
  assistantText: '',
  environment: state.environment,
});

function reduceTranscriptEvent(
  conversation: ConversationHistory,
  event: TranscriptEvent,
  state: ProjectionState,
): { conversation: ConversationHistory; state: ProjectionState } {
  const { environment } = state;

  switch (event.kind) {
    case 'user.message':
      return {
        conversation: appendMessages(
          conversation,
          { role: 'user', content: event.content },
          environment,
        ),
        state,
      };
    case 'assistant.delta': {
      let nextConversation = conversation;
      let messageId = state.assistantMessageId;
      if (!messageId) {
        const appended = appendUnsafeStreamingMessage(
          nextConversation,
          'assistant',
          undefined,
          environment,
        );
        nextConversation = appended.conversation;
        messageId = appended.messageId;
      }

      const assistantText = state.assistantText + event.delta;
      return {
        conversation: updateUnsafeStreamingMessage(
          nextConversation,
          messageId,
          assistantText,
          environment,
        ),
        state: { assistantMessageId: messageId, assistantText, environment },
      };
    }
    case 'assistant.done': {
      if (!state.assistantMessageId) {
        return { conversation, state };
      }

      return {
        conversation: finalizeUnsafeStreamingMessage(
          conversation,
          state.assistantMessageId,
          undefined,
          environment,
        ),
        state: clearAssistantState(state),
      };
    }
    case 'assistant.interrupted': {
      if (!state.assistantMessageId) {
        return { conversation, state };
      }

      return {
        conversation: cancelStreamingMessage(conversation, state.assistantMessageId, environment),
        state: clearAssistantState(state),
      };
    }
    case 'tool.call':
      return {
        conversation: appendMessages(
          conversation,
          {
            role: 'tool-call',
            content: '',
            toolCall: {
              id: event.callId,
              name: event.name,
              arguments: event.arguments,
            },
          },
          environment,
        ),
        state,
      };
    case 'tool.result':
      return {
        conversation: appendMessages(
          conversation,
          {
            role: 'tool-result',
            content: event.content,
            toolResult: {
              callId: event.callId,
              outcome: 'success',
              content: event.content,
            },
          },
          environment,
        ),
        state,
      };
  }
}

function createTranscriptProjection(seed = createSeed()) {
  return createProjection<TranscriptEvent, ProjectionState>({
    seed,
    initialState,
    identify: (event) => event.id,
    reduce({ conversation, event, state }) {
      return reduceTranscriptEvent(conversation, event, state);
    },
  });
}

function buildConversation(events: readonly TranscriptEvent[]): ConversationHistory {
  const projection = createTranscriptProjection();
  projection.apply(events);
  return projection.snapshot();
}

function expectIncrementalProjectionToEqualPureFold(
  events: readonly TranscriptEvent[],
  chunkSizes: readonly number[],
) {
  const projection = createTranscriptProjection();
  let count = 0;

  for (const chunkSize of chunkSizes) {
    count += chunkSize;
    projection.apply(events.slice(0, count));
    expect(projection.snapshot()).toEqual(buildConversation(events.slice(0, count)));
  }

  expect(projection.snapshot()).toEqual(buildConversation(events));
  expect(projection.processedCount).toBe(events.length);
}

describe('createProjection', () => {
  const messageContents = (conversation: ConversationHistory): string[] =>
    getMessages(conversation).map((message) => message.content as string);

  it('keeps incremental multi-turn streaming projection equivalent to pure full rebuilds', () => {
    const events: TranscriptEvent[] = [
      { id: '1', kind: 'user.message', content: 'Where is my order?' },
      { id: '2', kind: 'assistant.delta', delta: 'I can ' },
      { id: '3', kind: 'assistant.delta', delta: 'check that.' },
      { id: '4', kind: 'assistant.done' },
      { id: '5', kind: 'user.message', content: 'Use the latest tracking event.' },
      { id: '6', kind: 'assistant.delta', delta: 'The latest update says ' },
      { id: '7', kind: 'assistant.delta', delta: 'it arrives today.' },
      { id: '8', kind: 'assistant.done' },
    ];

    expectIncrementalProjectionToEqualPureFold(events, [1, 2, 1, 2, 2]);
  });

  it('keeps tool-call and tool-result projection equivalent to pure full rebuilds', () => {
    const events: TranscriptEvent[] = [
      { id: '1', kind: 'user.message', content: 'Check the forecast.' },
      {
        id: '2',
        kind: 'tool.call',
        callId: 'call-weather',
        name: 'weather',
        arguments: { city: 'Denver' },
      },
      { id: '3', kind: 'tool.result', callId: 'call-weather', content: 'Sunny and 72F.' },
      { id: '4', kind: 'assistant.delta', delta: 'It is sunny ' },
      { id: '5', kind: 'assistant.delta', delta: 'and 72F.' },
      { id: '6', kind: 'assistant.done' },
    ];

    expectIncrementalProjectionToEqualPureFold(events, [2, 1, 2, 1]);
  });

  it('resets and refolds when a cumulative log diverges from the previous prefix', () => {
    const projection = createTranscriptProjection();
    const firstLog: TranscriptEvent[] = [
      { id: '1', kind: 'user.message', content: 'Start the task.' },
      { id: '2', kind: 'assistant.delta', delta: 'Working' },
    ];
    const reconnectedLog: TranscriptEvent[] = [
      { id: '1', kind: 'user.message', content: 'Start the task.' },
      { id: '3', kind: 'assistant.interrupted' },
      { id: '4', kind: 'user.message', content: 'Actually, stop.' },
    ];

    projection.apply(firstLog);
    projection.apply(reconnectedLog);

    expect(projection.snapshot()).toEqual(buildConversation(reconnectedLog));
    expect(projection.processedCount).toBe(reconnectedLog.length);
  });

  it('compares prefix extensions by stable event identity instead of object identity', () => {
    let reducerCalls = 0;
    const environment = createTestEnvironment();
    const projection = createProjection<TranscriptEvent>({
      seed: createSeed(),
      identify: (event) => event.id,
      reduce({ conversation, event }) {
        reducerCalls += 1;
        return appendMessages(conversation, { role: 'user', content: event.id }, environment);
      },
    });

    projection.apply([{ id: '1', kind: 'user.message', content: 'First object' }]);
    projection.apply([
      { id: '1', kind: 'user.message', content: 'Equivalent proxied object' },
      { id: '2', kind: 'user.message', content: 'Tail event' },
    ]);

    expect(reducerCalls).toBe(2);
    expect(projection.processedCount).toBe(2);
    expect(isProjectionPrefixExtension(['1'], ['1', '2'])).toBe(true);
    expect(isProjectionPrefixExtension(['1', '2'], ['1', '3'])).toBe(false);
  });

  it('uses log keys to refold independent logs with colliding event identities', () => {
    let reducerCalls = 0;
    const environment = createTestEnvironment();
    const projection = createProjection<{ id: string; content: string }>({
      seed: createSeed(),
      identify: (event) => event.id,
      reduce({ conversation, event }) {
        reducerCalls += 1;
        return appendMessages(conversation, { role: 'user', content: event.content }, environment);
      },
    });

    projection.apply(
      [
        { id: '1', content: 'First session message' },
        { id: '2', content: 'First session tail' },
      ],
      { logKey: 'session-a' },
    );
    projection.apply(
      [
        { id: '1', content: 'Second session message' },
        { id: '2', content: 'Second session tail' },
        { id: '3', content: 'Second session extension' },
      ],
      { logKey: 'session-b' },
    );

    expect(reducerCalls).toBe(5);
    expect(messageContents(projection.snapshot())).toEqual([
      'Second session message',
      'Second session tail',
      'Second session extension',
    ]);
  });

  it('creates fresh object state when divergent logs refold from the seed', () => {
    const environment = createTestEnvironment();
    const projection = createProjection<{ id: string; content: string }, { count: number }>({
      seed: createSeed(),
      initialState: { count: 0 },
      identify: (event) => event.id,
      reduce({ conversation, event, state }) {
        state.count += 1;
        return {
          conversation: appendMessages(
            conversation,
            { role: 'user', content: `${event.content}:${state.count}` },
            environment,
          ),
          state,
        };
      },
    });

    projection.apply([{ id: '1', content: 'Original' }]);
    projection.apply([{ id: '2', content: 'Refolded' }]);

    expect(messageContents(projection.snapshot())).toEqual(['Refolded:1']);
  });

  it('throws when a stateful reducer returns conversation without state', () => {
    const projection = createProjection<{ id: string }, { count: number }>({
      seed: createSeed(),
      initialState: { count: 0 },
      identify: (event) => event.id,
      reduce({ conversation }) {
        return { conversation } as never;
      },
    });

    expect(() => projection.apply([{ id: '1' }])).toThrow(
      'Projection reducer returned a conversation without state.',
    );
  });
});
