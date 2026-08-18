import { describe, expect, it } from 'bun:test';

import {
  appendAssistantMessage,
  appendMessages,
  appendUserMessage,
  createConversationHistory,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from '../src/conversation';
import { ConversationalistError } from '../src/errors';
import { redactPii } from '../src/plugins/pii-redaction';
import type {
  AssistantMessage,
  ConversationHistory,
  MessagePlugin,
  ToolResult,
} from '../src/types';

const environment = {
  now: () => '2026-08-18T12:00:00.000Z',
  randomId: (() => {
    let nextId = 0;
    return () => `message-${++nextId}`;
  })(),
};

const expectValid = (history: ConversationHistory): void => {
  expect(validateConversationHistoryIntegrity(history)).toEqual([]);
};

describe('immutable transcript mutations', () => {
  it('updates editable message fields while preserving identity and the input history', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'assistant',
        content: 'Original',
        metadata: { source: 'seed' },
        goalCompleted: true,
      },
      environment,
    );
    const messageId = history.ids[0]!;
    const originalMessage = history.messages[messageId] as AssistantMessage;
    const originalSnapshot = structuredClone(history);
    const updates = {
      content: [{ type: 'text' as const, text: 'Updated' }],
      metadata: { source: 'edit', nested: { status: 'active' } },
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      cacheBoundary: true,
    };

    const updated = updateMessage(history, messageId, updates, environment);

    expect(updated).not.toBe(history);
    expect(updated.messages[messageId]).toMatchObject({
      id: originalMessage.id,
      role: 'assistant',
      content: [{ type: 'text', text: 'Updated' }],
      position: originalMessage.position,
      createdAt: originalMessage.createdAt,
      metadata: { source: 'edit', nested: { status: 'active' } },
      tokenUsage: { prompt: 1, completion: 2, total: 3 },
      cacheBoundary: true,
    });
    expect((updated.messages[messageId] as AssistantMessage).goalCompleted).toBeTrue();
    expect(updated.updatedAt).toBe(environment.now());
    expect(history).toEqual(originalSnapshot);
    expect(history.messages[messageId]).toBe(originalMessage);
    const updatedNestedMetadata = updated.messages[messageId]?.metadata.nested;
    expect(updatedNestedMetadata).not.toBe(updates.metadata.nested);
    expectValid(updated);
  });

  it('returns the original history when updating an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(updateMessage(history, 'missing', { content: 'No change' }, environment)).toBe(history);
  });

  it('clears optional message fields when they are explicitly undefined', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'user',
        content: 'Clear fields',
        tokenUsage: { prompt: 1, completion: 2, total: 3 },
        cacheBoundary: true,
      },
      environment,
    );
    const messageId = history.ids[0]!;

    const updated = updateMessage(
      history,
      messageId,
      { tokenUsage: undefined, cacheBoundary: undefined },
      environment,
    );

    expect(updated.messages[messageId]?.tokenUsage).toBeUndefined();
    expect(updated.messages[messageId]?.cacheBoundary).toBeUndefined();
    expect(history.messages[messageId]?.tokenUsage).toEqual({ prompt: 1, completion: 2, total: 3 });
    expect(history.messages[messageId]?.cacheBoundary).toBeTrue();
    expectValid(updated);
  });

  it('treats inherited object keys as unknown message identifiers', () => {
    const history = createConversationHistory({}, environment);

    expect(updateMessage(history, 'constructor', { content: 'No change' }, environment)).toBe(
      history,
    );
    expect(removeMessage(history, 'toString', environment)).toBe(history);
    expect(setMessageHidden(history, '__proto__', true, environment)).toBe(history);
  });

  it('runs message plugins over updated content', () => {
    const pluginEnvironment = { ...environment, plugins: [redactPii] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(
      history,
      messageId,
      { content: 'Contact user@example.com' },
      pluginEnvironment,
    );

    expect(updated.messages[messageId]?.content).toBe('Contact [EMAIL_REDACTED]');
    expect(history.messages[messageId]?.content).toBe('Original');
    expectValid(updated);
  });

  it('rejects non-idempotent string transformations', () => {
    const prefixContent: MessagePlugin = (input) => ({
      ...input,
      content: typeof input.content === 'string' ? `processed:${input.content}` : input.content,
    });
    const pluginEnvironment = { ...environment, plugins: [prefixContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() => setMessageHidden(history, messageId, true, pluginEnvironment)).toThrow(
      ConversationalistError,
    );
    expect(history.messages[messageId]?.content).toBe('processed:Original');
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects non-idempotent multimodal transformations', () => {
    const prefixTextBlocks: MessagePlugin = (input) => ({
      ...input,
      content:
        typeof input.content === 'string'
          ? input.content
          : input.content.map((part) =>
              part.type === 'text' ? { ...part, text: `processed:${part.text}` } : part,
            ),
    });
    const pluginEnvironment = { ...environment, plugins: [prefixTextBlocks] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(
      history,
      [{ type: 'text', text: 'Original' }],
      undefined,
      pluginEnvironment,
    );
    const messageId = history.ids[0]!;
    const originalContent = history.messages[messageId]?.content;
    const originalSnapshot = structuredClone(history);

    expect(() => setMessageHidden(history, messageId, true, pluginEnvironment)).toThrow(
      ConversationalistError,
    );
    expect(originalContent).toEqual([{ type: 'text', text: 'processed:Original' }]);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects non-idempotent visibility plugins during a content update', () => {
    const toggleVisibility: MessagePlugin = (input) => ({
      ...input,
      hidden: !input.hidden,
    });
    const pluginEnvironment = { ...environment, plugins: [toggleVisibility] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(history, messageId, { content: 'Edited' }, pluginEnvironment),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects non-idempotent plugin output conditional on the updated input', () => {
    const processEditedContentTwice: MessagePlugin = (input) => ({
      ...input,
      content:
        input.content === 'Edited'
          ? 'processed:Edited'
          : input.content === 'processed:Edited'
            ? 'final:Edited'
            : input.content,
    });
    const pluginEnvironment = { ...environment, plugins: [processEditedContentTwice] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Original', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(history, messageId, { content: 'Edited' }, pluginEnvironment),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('preserves cross-field plugin transformations caused by an update', () => {
    const hideBlockedContent: MessagePlugin = (input) => ({
      ...input,
      hidden: input.content === 'Blocked' ? true : input.hidden,
    });
    const pluginEnvironment = { ...environment, plugins: [hideBlockedContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Allowed', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.hidden).toBeFalse();
    expect(updated.messages[messageId]?.content).toBe('Blocked');
    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expectValid(updated);
  });

  it('preserves cross-field changes when plugins transform stored input again', () => {
    const prefixAndHideBlockedContent: MessagePlugin = (input) => ({
      ...input,
      content:
        typeof input.content === 'string' && !input.content.startsWith('processed:')
          ? `processed:${input.content}`
          : input.content,
      hidden: input.content === 'Allowed' ? input.hidden : true,
    });
    const pluginEnvironment = { ...environment, plugins: [prefixAndHideBlockedContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Allowed', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.content).toBe('processed:Allowed');
    expect(history.messages[messageId]?.hidden).toBeFalse();
    expect(updated.messages[messageId]?.content).toBe('processed:Blocked');
    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expectValid(updated);
  });

  it('preserves plugin visibility when a stored marker masks the edited field', () => {
    const markProcessedAndHideBlockedContent: MessagePlugin = (input) => ({
      ...input,
      metadata: { ...input.metadata, processed: true },
      hidden: input.metadata?.processed === true || input.content === 'Blocked',
    });
    const pluginEnvironment = { ...environment, plugins: [markProcessedAndHideBlockedContent] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendUserMessage(history, 'Allowed', undefined, pluginEnvironment);
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.metadata).toEqual({ processed: true });
    expect(history.messages[messageId]?.hidden).toBeFalse();
    expect(updated.messages[messageId]?.content).toBe('Blocked');
    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expectValid(updated);
  });

  it('preserves cross-field plugin transformations to a tool-call payload', () => {
    const clearBlockedToolArguments: MessagePlugin = (input) => ({
      ...input,
      toolCall:
        input.content === 'Blocked' && input.toolCall
          ? { ...input.toolCall, arguments: {} }
          : input.toolCall,
    });
    const pluginEnvironment = { ...environment, plugins: [clearBlockedToolArguments] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: 'Allowed',
        toolCall: { id: 'call-1', name: 'lookup', arguments: { secret: 'value' } },
      },
      pluginEnvironment,
    );
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(history.messages[messageId]?.toolCall?.arguments).toEqual({ secret: 'value' });
    expect(updated.messages[messageId]?.toolCall).toEqual({
      id: 'call-1',
      name: 'lookup',
      arguments: {},
    });
    expectValid(updated);
  });

  it('rejects a plugin that retargets a tool call during an update', () => {
    const retargetBlockedToolCall: MessagePlugin = (input) => ({
      ...input,
      toolCall:
        input.content === 'Blocked' && input.toolCall
          ? { ...input.toolCall, id: 'call-2' }
          : input.toolCall,
    });
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: 'Allowed',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      environment,
    );
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        messageId,
        { content: 'Blocked' },
        {
          ...environment,
          plugins: [retargetBlockedToolCall],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('includes preserved assistant completion state in plugin inputs', () => {
    const hideBlockedCompletedAssistant: MessagePlugin = (input) => ({
      ...input,
      hidden:
        input.role === 'assistant' && input.goalCompleted && input.content === 'Blocked'
          ? true
          : input.hidden,
    });
    const pluginEnvironment = { ...environment, plugins: [hideBlockedCompletedAssistant] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      { role: 'assistant', content: 'Allowed', goalCompleted: true },
      pluginEnvironment,
    );
    const messageId = history.ids[0]!;

    const updated = updateMessage(history, messageId, { content: 'Blocked' }, pluginEnvironment);

    expect(updated.messages[messageId]?.hidden).toBeTrue();
    expect((updated.messages[messageId] as AssistantMessage).goalCompleted).toBeTrue();
    expectValid(updated);
  });

  it('rejects nondeterministic message plugins instead of manufacturing mutation deltas', () => {
    let sequence = 0;
    const statefulMetadata: MessagePlugin = (input) => ({
      ...input,
      metadata: { ...input.metadata, sequence: ++sequence },
    });
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'Original', undefined, environment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      setMessageHidden(history, messageId, true, {
        ...environment,
        plugins: [statefulMetadata],
      }),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects nondeterministic plugin output conditional on the updated input', () => {
    let sequence = 0;
    const statefulEditedMetadata: MessagePlugin = (input) => ({
      ...input,
      metadata:
        input.content === 'Edited' ? { ...input.metadata, sequence: ++sequence } : input.metadata,
    });
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'Original', undefined, environment);
    const messageId = history.ids[0]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        messageId,
        { content: 'Edited' },
        {
          ...environment,
          plugins: [statefulEditedMetadata],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('removes a message and restores contiguous positions without mutating survivors', () => {
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'First', undefined, environment);
    history = appendAssistantMessage(history, 'Remove me', undefined, environment);
    history = appendUserMessage(history, 'Third', undefined, environment);
    const [firstId, removedId, thirdId] = history.ids as [string, string, string];
    const firstMessage = history.messages[firstId]!;
    const thirdMessage = history.messages[thirdId]!;
    const originalSnapshot = structuredClone(history);

    const updated = removeMessage(history, removedId, environment);

    expect(updated.ids).toEqual([firstId, thirdId]);
    expect(updated.messages[removedId]).toBeUndefined();
    expect(updated.messages[firstId]).toBe(firstMessage);
    expect(updated.messages[thirdId]).not.toBe(thirdMessage);
    expect(updated.messages[firstId]?.position).toBe(0);
    expect(updated.messages[thirdId]?.position).toBe(1);
    expect(history).toEqual(originalSnapshot);
    expectValid(updated);
  });

  it('returns the original history when removing an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(removeMessage(history, 'missing', environment)).toBe(history);
  });

  it('rejects removal that would leave an orphaned tool result', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: null },
      },
      environment,
    );

    expect(() => removeMessage(history, history.ids[0]!, environment)).toThrow(
      ConversationalistError,
    );
    expectValid(history);
  });

  it('sets and clears message visibility without mutating the input message', () => {
    let history = createConversationHistory({}, environment);
    history = appendUserMessage(history, 'Toggle me', undefined, environment);
    const messageId = history.ids[0]!;
    const originalMessage = history.messages[messageId]!;

    const hidden = setMessageHidden(history, messageId, true, environment);
    const visible = setMessageHidden(hidden, messageId, false, environment);

    expect(hidden.messages[messageId]?.hidden).toBeTrue();
    expect(visible.messages[messageId]?.hidden).toBeFalse();
    expect(history.messages[messageId]).toBe(originalMessage);
    expect(originalMessage.hidden).toBeFalse();
    expectValid(hidden);
    expectValid(visible);
  });

  it('returns the original history when hiding an unknown message', () => {
    const history = createConversationHistory({}, environment);

    expect(setMessageHidden(history, 'missing', true, environment)).toBe(history);
  });

  it('replaces the result for a tool-call identifier without mutating the input result', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: { accountId: 'account-1' } },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );
    const resultMessageId = history.ids[1]!;
    const originalMessage = history.messages[resultMessageId]!;
    const replacement: ToolResult = {
      callId: 'call-1',
      outcome: 'success',
      content: { nested: { status: 'active' } },
    };
    const originalReplacement = structuredClone(replacement);

    const updated = replaceToolResult(history, 'call-1', replacement, environment);

    expect(updated.messages[resultMessageId]).not.toBe(originalMessage);
    expect(updated.messages[resultMessageId]).toMatchObject({
      id: originalMessage.id,
      position: originalMessage.position,
      createdAt: originalMessage.createdAt,
      toolResult: replacement,
    });
    expect(history.messages[resultMessageId]).toBe(originalMessage);
    expect(replacement).toEqual(originalReplacement);
    expect(updated.messages[resultMessageId]?.toolResult).not.toBe(replacement);
    expectValid(updated);
  });

  it('returns the original history for an unknown tool-call identifier', () => {
    const history = createConversationHistory({}, environment);
    const replacement: ToolResult = {
      callId: 'missing',
      outcome: 'success',
      content: null,
    };

    expect(replaceToolResult(history, 'missing', replacement, environment)).toBe(history);
  });

  it('runs message plugins over replacement tool results', () => {
    const pluginEnvironment = { ...environment, plugins: [redactPii] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      pluginEnvironment,
    );

    const updated = replaceToolResult(
      history,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: { email: 'user@example.com' } },
      pluginEnvironment,
    );

    expect(updated.messages[history.ids[1]!]?.toolResult?.content).toEqual({
      email: '[EMAIL_REDACTED]',
    });
    expect(history.messages[history.ids[1]!]?.toolResult?.content).toBeNull();
    expectValid(updated);
  });

  it('preserves cross-field plugin transformations caused by a replacement tool result', () => {
    const annotateSuccessfulResult: MessagePlugin = (input) => ({
      ...input,
      metadata:
        input.toolResult?.outcome === 'success' ? { reviewed: true } : { actionRequired: true },
    });
    const pluginEnvironment = { ...environment, plugins: [annotateSuccessfulResult] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      pluginEnvironment,
    );
    const resultMessageId = history.ids[1]!;

    const updated = replaceToolResult(
      history,
      'call-1',
      { callId: 'call-1', outcome: 'success', content: null },
      pluginEnvironment,
    );

    expect(history.messages[resultMessageId]?.metadata).toEqual({ actionRequired: true });
    expect(updated.messages[resultMessageId]?.metadata).toEqual({ reviewed: true });
    expectValid(updated);
  });

  it('preserves masked plugin transformations to a tool-result payload', () => {
    const markProcessedAndClearBlockedResult: MessagePlugin = (input) => ({
      ...input,
      metadata: { ...input.metadata, processed: true },
      toolResult:
        input.toolResult && (input.metadata?.processed === true || input.content === 'Blocked')
          ? { ...input.toolResult, content: null }
          : input.toolResult,
    });
    const pluginEnvironment = { ...environment, plugins: [markProcessedAndClearBlockedResult] };
    let history = createConversationHistory({}, pluginEnvironment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'Allowed',
        toolResult: { callId: 'call-1', outcome: 'success', content: { secret: 'value' } },
      },
      pluginEnvironment,
    );
    const resultMessageId = history.ids[1]!;

    const updated = updateMessage(
      history,
      resultMessageId,
      { content: 'Blocked' },
      pluginEnvironment,
    );

    expect(history.messages[resultMessageId]?.toolResult?.content).toEqual({ secret: 'value' });
    expect(updated.messages[resultMessageId]?.toolResult?.content).toBeNull();
    expect(updated.messages[resultMessageId]?.toolResult?.callId).toBe('call-1');
    expectValid(updated);
  });

  it('rejects a replacement whose call identifier does not match the target', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );

    expect(() =>
      replaceToolResult(
        history,
        'call-1',
        { callId: 'call-2', outcome: 'success', content: null },
        environment,
      ),
    ).toThrow(ConversationalistError);
    expectValid(history);
  });

  it('rejects retargeting a result to another existing tool call', () => {
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );

    expect(() =>
      replaceToolResult(
        history,
        'call-1',
        { callId: 'call-2', outcome: 'success', content: null },
        environment,
      ),
    ).toThrow(ConversationalistError);
    expectValid(history);
  });

  it('rejects a plugin that retargets a replacement result after processing', () => {
    const retargetResult: MessagePlugin = (input) => ({
      ...input,
      toolResult: input.toolResult ? { ...input.toolResult, callId: 'call-2' } : undefined,
    });
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );
    const originalSnapshot = structuredClone(history);

    expect(() =>
      replaceToolResult(
        history,
        'call-1',
        { callId: 'call-1', outcome: 'success', content: null },
        { ...environment, plugins: [retargetResult] },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects a plugin that retargets an existing result during a general update', () => {
    const retargetEditedResult: MessagePlugin = (input) => ({
      ...input,
      toolResult:
        input.content === 'Edited' && input.toolResult
          ? { ...input.toolResult, callId: 'call-2' }
          : input.toolResult,
    });
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-1', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'action_required', content: null },
      },
      environment,
    );
    const resultMessageId = history.ids[2]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        resultMessageId,
        { content: 'Edited' },
        {
          ...environment,
          plugins: [retargetEditedResult],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });

  it('rejects plugin retargeting when the preserved call identifier is empty', () => {
    const retargetEditedResult: MessagePlugin = (input) => ({
      ...input,
      toolResult:
        input.content === 'Edited' && input.toolResult
          ? { ...input.toolResult, callId: 'call-2' }
          : input.toolResult,
    });
    let history = createConversationHistory({}, environment);
    history = appendMessages(
      history,
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: '', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'call-2', name: 'lookup', arguments: {} },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: '', outcome: 'action_required', content: null },
      },
      environment,
    );
    const resultMessageId = history.ids[2]!;
    const originalSnapshot = structuredClone(history);

    expect(() =>
      updateMessage(
        history,
        resultMessageId,
        { content: 'Edited' },
        {
          ...environment,
          plugins: [retargetEditedResult],
        },
      ),
    ).toThrow(ConversationalistError);
    expect(history).toEqual(originalSnapshot);
    expectValid(history);
  });
});
