import { describe, expect, it } from 'bun:test';

import type { ConversationEnvironment } from '../src';
import {
  appendMessages,
  Conversation,
  createConversationHistory as createConversation,
} from '../src';
import { createPIIRedactionPlugin, redactPii } from '../src/plugins/pii-redaction';
import type { Message, MessageInput } from '../src/types';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('redactPii', () => {
  it('should redact emails', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(conv, { role: 'user', content: 'My email is test@example.com' }, env);

    expect(getOrderedMessages(conv)[0].content).toBe('My email is [EMAIL_REDACTED]');
  });

  it('should redact phone numbers', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(conv, { role: 'user', content: 'Call me at 123-456-7890' }, env);

    expect(getOrderedMessages(conv)[0].content).toBe('Call me at [PHONE_REDACTED]');
  });

  it('should redact API keys', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(
      conv,
      {
        role: 'user',
        content: 'My key is api_key: "sk-1234567890abcdef1234567890abcdef"',
      },
      env,
    );

    expect(getOrderedMessages(conv)[0].content).toBe('My key is api_key: "[KEY_REDACTED]"');
  });

  it('should redact multi-modal content', () => {
    const env = { plugins: [redactPii] };
    let conv = createConversation({}, env);
    conv = appendMessages(
      conv,
      {
        role: 'user',
        content: [
          { type: 'text', text: 'My email is test@example.com' },
          { type: 'image', url: 'https://example.com/image.png' },
        ],
      },
      env,
    );

    expect(getOrderedMessages(conv)[0].content).toEqual([
      { type: 'text', text: 'My email is [EMAIL_REDACTED]' },
      { type: 'image', url: 'https://example.com/image.png' },
    ]);
  });

  it('should not redact by default', () => {
    let conv = createConversation({});
    conv = appendMessages(conv, {
      role: 'user',
      content: 'My email is test@example.com',
    });

    expect(getOrderedMessages(conv)[0].content).toBe('My email is test@example.com');
  });

  it('should work when bound to Conversation', () => {
    const env = { plugins: [redactPii] };
    const history = new Conversation(createConversation(), env);
    const boundAppend = history.bind(
      (conversation, input: MessageInput, boundEnv?: Partial<ConversationEnvironment>) =>
        appendMessages(conversation, input, boundEnv),
    );

    boundAppend({ role: 'user', content: 'My email is test@example.com' });

    expect(getOrderedMessages(history.current)[0].content).toBe('My email is [EMAIL_REDACTED]');
  });

  it('should support custom redaction rules', () => {
    const customPlugin = createPIIRedactionPlugin({
      rules: {
        ssn: {
          regex: /\d{3}-\d{2}-\d{4}/g,
          replace: '[SSN_REDACTED]',
        },
      },
    });

    const env = { plugins: [customPlugin] };
    let conv = createConversation({}, env);
    conv = appendMessages(conv, { role: 'user', content: 'SSN: 123-45-6789' }, env);

    expect(getOrderedMessages(conv)[0].content).toBe('SSN: [SSN_REDACTED]');
  });

  it('should support excluding default rules', () => {
    const customPlugin = createPIIRedactionPlugin({
      excludeRules: ['email'],
    });

    const env = { plugins: [customPlugin] };
    let conv = createConversation({}, env);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Email: test@example.com, Phone: 123-456-7890' },
      env,
    );

    expect(getOrderedMessages(conv)[0].content).toBe(
      'Email: test@example.com, Phone: [PHONE_REDACTED]',
    );
  });

  it('should validate tool references after plugins are applied', () => {
    const maliciousPlugin = (input: MessageInput): MessageInput => {
      if (input.role === 'tool-result' && input.toolResult) {
        return {
          ...input,
          toolResult: { ...input.toolResult, callId: 'invalid-id' },
        };
      }
      return input;
    };

    const env = { plugins: [maliciousPlugin] };
    const conv = createConversation({ id: 'test' }, env);

    const action = () =>
      appendMessages(
        conv,
        {
          role: 'tool-call',
          content: '',
          toolCall: { id: 'valid-id', name: 'test', arguments: {} },
        },
        {
          role: 'tool-result',
          content: '',
          toolResult: { callId: 'valid-id', outcome: 'success', content: {} },
        },
        env,
      );

    // This should fail because the plugin changes the callId to 'invalid-id'
    // If it doesn't fail, it means validation happened before the plugin.
    expect(action).toThrow(/tool result references non-existent tool-call: invalid-id/);
  });
});

describe('PII redaction in tool arguments, results, and metadata', () => {
  it('redacts PII in toolCall.arguments', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'tool-call',
      content: '',
      toolCall: {
        id: 'tc-1',
        name: 'sendEmail',
        arguments: { to: 'user@example.com', subject: 'Hello' },
      },
    };

    const result = plugin(input);
    const args = result.toolCall!.arguments as Record<string, unknown>;
    expect(args.to).toBe('[EMAIL_REDACTED]');
    expect(args.subject).toBe('Hello');
  });

  it('redacts PII in toolResult.content', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'tool-result',
      content: 'Result',
      toolResult: {
        callId: 'tc-1',
        outcome: 'success',
        content: 'Contact user@example.com or call 555-123-4567',
      },
    };

    const result = plugin(input);
    const content = result.toolResult!.content as string;
    expect(content).toContain('[EMAIL_REDACTED]');
    expect(content).toContain('[PHONE_REDACTED]');
  });

  it('redacts PII in nested arrays within tool result content', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'tool-result',
      content: 'Result',
      toolResult: {
        callId: 'tc-1',
        outcome: 'success',
        content: { contacts: ['alice@example.com', 'bob@example.com'] },
      },
    };

    const result = plugin(input);
    const content = result.toolResult!.content as Record<string, unknown>;
    const contacts = content.contacts as string[];
    expect(contacts[0]).toBe('[EMAIL_REDACTED]');
    expect(contacts[1]).toBe('[EMAIL_REDACTED]');
  });

  it('redacts PII in metadata values', () => {
    const plugin = createPIIRedactionPlugin();
    const input: MessageInput = {
      role: 'user',
      content: 'Hello',
      metadata: {
        email: 'secret@example.com',
        nested: { phone: '555-123-4567' },
      },
    };

    const result = plugin(input);
    expect(result.metadata!.email).toBe('[EMAIL_REDACTED]');
    expect((result.metadata!.nested as Record<string, unknown>).phone).toBe('[PHONE_REDACTED]');
  });
});
