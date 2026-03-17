import { describe, expect, test } from 'bun:test';

import { isAssistantMessage } from '../../src';
import {
  fromMarkdown,
  getRoleFromLabel,
  getRoleLabel,
  LABEL_TO_ROLE,
  MarkdownParseError,
  ROLE_LABELS,
  toMarkdown,
} from '../../src/markdown';
import type { MultiModalContent } from '../../src/multi-modal';
import type {
  AssistantMessage,
  Conversation,
  Message,
  MessageRole,
} from '../../src/types';

type ConversationMessage = Message | AssistantMessage;

type ConversationOverrides = Partial<Omit<Conversation, 'messages' | 'ids'>> & {
  messages?: ConversationMessage[];
  ids?: string[];
};

const toMessageRecord = (messages: ConversationMessage[]): Record<string, Message> =>
  messages.reduce<Record<string, Message>>((acc, message) => {
    acc[message.id] = message;
    return acc;
  }, {});

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('toMarkdown', () => {
  const createConversation = (
    messages: ConversationMessage[],
    overrides: ConversationOverrides = {},
  ): Conversation => {
    const { messages: overrideMessages, ids, ...rest } = overrides;
    const baseMessages = overrideMessages ?? messages;
    const baseIds = ids ?? baseMessages.map((message) => message.id);

    return {
      schemaVersion: 1,
      id: 'conv-1',
      status: 'active',
      metadata: {},
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: '2024-01-15T10:00:00.000Z',
      ...rest,
      messages: toMessageRecord(baseMessages),
      ids: baseIds,
    };
  };

  describe('default behavior (no metadata)', () => {
    test('outputs empty string for empty conversation', () => {
      const conversation = createConversation([]);
      const result = toMarkdown(conversation);
      expect(result).toBe('');
    });

    test('outputs simple markdown without frontmatter', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello, world!',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).not.toContain('---');
      expect(result).not.toContain('<!--');
      expect(result).toContain('### User');
      expect(result).not.toContain('(2024-01-15'); // No timestamp in simple mode
      expect(result).toContain('Hello, world!');
    });

    test('formats multiple messages correctly', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hi there',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Hello! How can I help?',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('### User');
      expect(result).toContain('Hi there');
      expect(result).toContain('### Assistant');
      expect(result).toContain('Hello! How can I help?');
    });

    test('formats all role types correctly', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'system',
          content: 'System',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'developer',
          content: 'Dev',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-3',
          role: 'tool-use',
          content: 'Tool',
          position: 2,
          createdAt: '2024-01-15T10:02:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-4',
          role: 'tool-result',
          content: 'Result',
          position: 3,
          createdAt: '2024-01-15T10:03:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-5',
          role: 'snapshot',
          content: 'Snap',
          position: 4,
          createdAt: '2024-01-15T10:04:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('### System');
      expect(result).toContain('### Developer');
      expect(result).toContain('### Tool Use');
      expect(result).toContain('### Tool Result');
      expect(result).toContain('### Snapshot');
    });

    test('renders images with alt text', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            { type: 'image', url: 'https://example.com/photo.jpg', text: 'A cat' },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('![A cat](https://example.com/photo.jpg)');
    });

    test('uses "image" as default alt text', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [{ type: 'image', url: 'https://example.com/photo.jpg' }],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('![image](https://example.com/photo.jpg)');
    });

    test('skips empty text parts', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            { type: 'text', text: 'Valid' },
            { type: 'text', text: '' },
            { type: 'text', text: '' },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation);
      expect(result).toContain('Valid');
    });
  });

  describe('with includeMetadata: true', () => {
    test('includes YAML frontmatter with conversation metadata', () => {
      const conversation = createConversation([], {
        id: 'conv-123',
        title: 'Test Conversation',
        status: 'archived',
        metadata: { key: 'value' },
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:30:00.000Z',
      });

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('---');
      expect(result).toContain('schemaVersion:');
      expect(result).toContain('id: conv-123');
      expect(result).toContain('title: Test Conversation');
      expect(result).toContain('status: archived');
      expect(result).toContain('key: value');
    });

    test('excludes title from frontmatter when undefined', () => {
      const conversation = createConversation([]);
      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).not.toContain('title:');
    });

    test('includes message metadata in YAML frontmatter keyed by message ID', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: { source: 'web' },
          hidden: true,
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('messages:');
      expect(result).toContain('msg-1:');
      expect(result).toContain('position: 0');
      expect(result).toContain('hidden: true');
      expect(result).toContain('source: web');
      expect(result).toContain('### User (msg-1)');
    });

    test('includes toolCall in message metadata', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'tool-use',
          content: 'Calling search',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolCall: { id: 'call-1', name: 'search', arguments: { query: 'test' } },
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('toolCall:');
      expect(result).toContain('id: call-1');
      expect(result).toContain('name: search');
    });

    test('includes toolResult in message metadata', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'tool-use',
          content: '',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolCall: { id: 'call-1', name: 'search', arguments: {} },
        },
        {
          id: 'msg-2',
          role: 'tool-result',
          content: 'Search results',
          position: 1,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolResult: { callId: 'call-1', outcome: 'success', content: 'Found it' },
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('toolResult:');
      expect(result).toContain('callId: call-1');
      expect(result).toContain('outcome: success');
    });

    test('includes tokenUsage in message metadata', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Response',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          tokenUsage: { prompt: 100, completion: 50, total: 150 },
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('tokenUsage:');
      expect(result).toContain('prompt: 100');
      expect(result).toContain('completion: 50');
      expect(result).toContain('total: 150');
    });

    test('includes goalCompleted in message metadata', () => {
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: 'Task complete',
        position: 0,
        createdAt: '2024-01-15T10:00:00.000Z',
        metadata: {},
        hidden: false,
        goalCompleted: true,
      };
      const conversation = createConversation([assistantMessage]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('goalCompleted: true');
    });

    test('includes content array in metadata for multi-modal messages', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: [
            { type: 'text', text: 'Check this:' },
            { type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' },
          ],
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
      ]);

      const result = toMarkdown(conversation, { includeMetadata: true });
      expect(result).toContain('content:');
      expect(result).toContain('mimeType: image/png');
    });
  });

  describe('export options', () => {
    test('omits hidden messages when includeHidden is false', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Visible',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'system',
          content: 'Secret',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: true,
        },
      ]);

      const result = toMarkdown(conversation, { includeHidden: false });
      expect(result).toContain('Visible');
      expect(result).not.toContain('Secret');
      expect(result).not.toContain('### System');
    });

    test('redacts hidden message content when requested', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Visible',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
        },
        {
          id: 'msg-2',
          role: 'system',
          content: 'Secret',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: true,
        },
      ]);

      const result = toMarkdown(conversation, {
        redactHiddenContent: true,
        redactedPlaceholder: '[HIDDEN]',
      });

      expect(result).toContain('### System');
      expect(result).toContain('[HIDDEN]');
      expect(result).not.toContain('Secret');
    });

    test('stripTransient removes transient metadata in frontmatter', () => {
      const conversation = createConversation(
        [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Hello',
            position: 0,
            createdAt: '2024-01-15T10:00:00.000Z',
            metadata: { _temp: 'nope', source: 'web' },
            hidden: false,
          },
        ],
        {
          metadata: { _draft: true, owner: 'test' },
        },
      );

      const result = toMarkdown(conversation, {
        includeMetadata: true,
        stripTransient: true,
      });

      expect(result).toContain('owner: test');
      expect(result).toContain('source: web');
      expect(result).not.toContain('_draft');
      expect(result).not.toContain('_temp');
    });

    test('redacts tool metadata in markdown frontmatter', () => {
      const conversation = createConversation([
        {
          id: 'msg-1',
          role: 'tool-use',
          content: 'Calling tool',
          position: 0,
          createdAt: '2024-01-15T10:00:00.000Z',
          metadata: {},
          hidden: false,
          toolCall: { id: 'call-1', name: 'search', arguments: 'secret args' },
        },
        {
          id: 'msg-2',
          role: 'tool-result',
          content: 'Result',
          position: 1,
          createdAt: '2024-01-15T10:01:00.000Z',
          metadata: {},
          hidden: false,
          toolResult: {
            callId: 'call-1',
            outcome: 'error',
            content: 'secret result',
          },
        },
      ]);

      const result = toMarkdown(conversation, {
        includeMetadata: true,
        redactToolArguments: true,
        redactToolResults: true,
        redactedPlaceholder: '[MASKED]',
      });

      expect(result).toContain('[MASKED]');
      expect(result).not.toContain('secret args');
      expect(result).not.toContain('secret result');
      expect(result).toContain('call-1');
      expect(result).toContain('search');
    });
  });
});

describe('fromMarkdown', () => {
  describe('simple markdown (without metadata)', () => {
    test('parses empty markdown to empty conversation', () => {
      const conversation = fromMarkdown('');
      expect(getOrderedMessages(conversation)).toHaveLength(0);
      expect(conversation.status).toBe('active');
      expect(conversation.metadata).toEqual({});
    });

    test('parses simple message without frontmatter', () => {
      const markdown = `### User

Hello, world!`;

      const conversation = fromMarkdown(markdown);
      expect(getOrderedMessages(conversation)).toHaveLength(1);
      expect(getOrderedMessages(conversation)[0].role).toBe('user');
      expect(getOrderedMessages(conversation)[0].content).toBe('Hello, world!');
      expect(getOrderedMessages(conversation)[0].hidden).toBe(false);
      expect(getOrderedMessages(conversation)[0].metadata).toEqual({});
    });

    test('generates unique IDs for conversation and messages', () => {
      const markdown = `### User

Hello`;

      const conv1 = fromMarkdown(markdown);
      const conv2 = fromMarkdown(markdown);

      expect(conv1.id).toBeTruthy();
      expect(conv2.id).toBeTruthy();
      expect(conv1.id).not.toBe(conv2.id);
      expect(getOrderedMessages(conv1)[0].id).not.toBe(getOrderedMessages(conv2)[0].id);
    });

    test('assigns positions based on message order', () => {
      const markdown = `### User

First

### Assistant

Second

### User

Third`;

      const conversation = fromMarkdown(markdown);
      expect(getOrderedMessages(conversation)[0].position).toBe(0);
      expect(getOrderedMessages(conversation)[1].position).toBe(1);
      expect(getOrderedMessages(conversation)[2].position).toBe(2);
    });

    test('parses all role types correctly', () => {
      const markdown = `### User

U

### Assistant

A

### System

S

### Developer

D

### Tool Use

TU

### Tool Result

TR

### Snapshot

SN`;

      const conversation = fromMarkdown(markdown);
      expect(getOrderedMessages(conversation)[0].role).toBe('user');
      expect(getOrderedMessages(conversation)[1].role).toBe('assistant');
      expect(getOrderedMessages(conversation)[2].role).toBe('system');
      expect(getOrderedMessages(conversation)[3].role).toBe('developer');
      expect(getOrderedMessages(conversation)[4].role).toBe('tool-use');
      expect(getOrderedMessages(conversation)[5].role).toBe('tool-result');
      expect(getOrderedMessages(conversation)[6].role).toBe('snapshot');
    });

    test('throws MarkdownParseError for unknown role', () => {
      const markdown = `### Unknown Role

Content`;

      expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
      expect(() => fromMarkdown(markdown)).toThrow('Unknown role');
    });
  });

  describe('with metadata (frontmatter)', () => {
    test('throws MarkdownParseError when required id field is missing from frontmatter', () => {
      // gray-matter parses most YAML gracefully, so test for missing required fields instead
      expect(() => fromMarkdown('---\nstatus: active\n---')).toThrow(MarkdownParseError);
      expect(() => fromMarkdown('---\nstatus: active\n---')).toThrow(
        'missing required field "id"',
      );
    });

    test('throws MarkdownParseError for invalid frontmatter YAML', () => {
      const markdown = `---
id: [unclosed
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

      expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
      expect(() => fromMarkdown(markdown)).toThrow('Invalid frontmatter');
    });

    test('throws MarkdownParseError for unknown role', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
---

### Unknown Role (msg-1)

Content`;

      expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
      expect(() => fromMarkdown(markdown)).toThrow('Unknown role');
    });

    test('throws MarkdownParseError when message metadata is missing', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---

### User (msg-1)

Content`;

      expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
      expect(() => fromMarkdown(markdown)).toThrow('Missing metadata for message: msg-1');
    });

    test('throws MarkdownParseError for invalid tool linkage', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    toolResult:
      callId: call-1
      outcome: success
      content: {}
---

### Tool Result (msg-1)

Tool output`;

      expect(() => fromMarkdown(markdown)).toThrow(MarkdownParseError);
      expect(() => fromMarkdown(markdown)).toThrow('Invalid markdown conversation');
    });

    test('parses conversation with no messages', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

      const conversation = fromMarkdown(markdown);
      expect(conversation.id).toBe('conv-1');
      expect(conversation.status).toBe('active');
      expect(getOrderedMessages(conversation)).toHaveLength(0);
    });

    test('parses conversation with title', () => {
      const markdown = `---
id: conv-1
title: My Conversation
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

      const conversation = fromMarkdown(markdown);
      expect(conversation.title).toBe('My Conversation');
    });

    test('parses conversation metadata', () => {
      const markdown = `---
id: conv-1
status: active
metadata:
  key: value
  count: 42
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages: {}
---`;

      const conversation = fromMarkdown(markdown);
      expect(conversation.metadata).toEqual({ key: 'value', count: 42 });
    });

    test('parses single text message', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
---

### User (msg-1)

Hello, world!`;

      const conversation = fromMarkdown(markdown);
      expect(getOrderedMessages(conversation)).toHaveLength(1);
      expect(getOrderedMessages(conversation)[0].id).toBe('msg-1');
      expect(getOrderedMessages(conversation)[0].role).toBe('user');
      expect(getOrderedMessages(conversation)[0].content).toBe('Hello, world!');
      expect(getOrderedMessages(conversation)[0].position).toBe(0);
      expect(getOrderedMessages(conversation)[0].hidden).toBe(false);
    });

    test('parses multiple messages', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
  msg-2:
    position: 1
    createdAt: '2024-01-15T10:01:00.000Z'
    metadata: {}
    hidden: false
---

### User (msg-1)

Hi there

### Assistant (msg-2)

Hello! How can I help?`;

      const conversation = fromMarkdown(markdown);
      expect(getOrderedMessages(conversation)).toHaveLength(2);
      expect(getOrderedMessages(conversation)[0].role).toBe('user');
      expect(getOrderedMessages(conversation)[1].role).toBe('assistant');
    });

    test('parses multi-modal content from metadata', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    content:
      - type: text
        text: 'Check this:'
      - type: image
        url: 'https://example.com/img.png'
        mimeType: image/png
---

### User (msg-1)

Check this:

![image](https://example.com/img.png)`;

      const conversation = fromMarkdown(markdown);
      const content = getOrderedMessages(conversation)[0].content as readonly {
        type: string;
      }[];
      expect(Array.isArray(content)).toBe(true);
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe('text');
      expect(content[1].type).toBe('image');
      expect((content[1] as any).mimeType).toBe('image/png');
    });

    test('parses toolCall metadata', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    toolCall:
      id: call-1
      name: search
      arguments:
        query: test
---

### Tool Use (msg-1)

Calling search`;

      const conversation = fromMarkdown(markdown);
      expect(getOrderedMessages(conversation)[0].toolCall).toBeDefined();
      expect(getOrderedMessages(conversation)[0].toolCall?.id).toBe('call-1');
      expect(getOrderedMessages(conversation)[0].toolCall?.name).toBe('search');
      expect(getOrderedMessages(conversation)[0].toolCall?.arguments).toEqual({
        query: 'test',
      });
    });

    test('parses toolResult metadata', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    toolCall:
      id: call-1
      name: search
      arguments: {}
  msg-2:
    position: 1
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    toolResult:
      callId: call-1
      outcome: success
      content: Found it
---

### Tool Use (msg-1)

Calling search

### Tool Result (msg-2)

Search results`;

      const conversation = fromMarkdown(markdown);
      const ordered = getOrderedMessages(conversation);
      expect(ordered[1]?.toolResult).toBeDefined();
      expect(ordered[1]?.toolResult?.callId).toBe('call-1');
      expect(ordered[1]?.toolResult?.outcome).toBe('success');
    });

    test('parses tokenUsage metadata', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    tokenUsage:
      prompt: 100
      completion: 50
      total: 150
---

### Assistant (msg-1)

Response`;

      const conversation = fromMarkdown(markdown);
      expect(getOrderedMessages(conversation)[0].tokenUsage).toBeDefined();
      expect(getOrderedMessages(conversation)[0].tokenUsage?.prompt).toBe(100);
      expect(getOrderedMessages(conversation)[0].tokenUsage?.completion).toBe(50);
      expect(getOrderedMessages(conversation)[0].tokenUsage?.total).toBe(150);
    });

    test('parses goalCompleted metadata', () => {
      const markdown = `---
id: conv-1
status: active
metadata: {}
createdAt: '2024-01-15T10:00:00.000Z'
updatedAt: '2024-01-15T10:00:00.000Z'
messages:
  msg-1:
    position: 0
    createdAt: '2024-01-15T10:00:00.000Z'
    metadata: {}
    hidden: false
    goalCompleted: true
---

### Assistant (msg-1)

Task complete`;

      const conversation = fromMarkdown(markdown);
      const message = getOrderedMessages(conversation)[0];
      expect(isAssistantMessage(message) && message.goalCompleted).toBe(true);
    });
  });
});

describe('toMarkdown/fromMarkdown round-trip', () => {
  const createMessage = (overrides: Partial<Message>): Message => ({
    id: 'msg-1',
    role: 'user',
    content: 'Hello',
    position: 0,
    createdAt: '2024-01-15T10:00:00.000Z',
    metadata: {},
    hidden: false,
    ...overrides,
  });
  const createAssistantMessage = (
    overrides: Partial<AssistantMessage> = {},
  ): AssistantMessage => ({
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello',
    position: 0,
    createdAt: '2024-01-15T10:00:00.000Z',
    metadata: {},
    hidden: false,
    ...overrides,
  });

  const createConversation = (
    messages: ConversationMessage[],
    overrides: ConversationOverrides = {},
  ): Conversation => {
    const { messages: overrideMessages, ids, ...rest } = overrides;
    const baseMessages = overrideMessages ?? messages;
    const baseIds = ids ?? baseMessages.map((message) => message.id);

    return {
      schemaVersion: 1,
      id: 'conv-1',
      status: 'active',
      metadata: {},
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: '2024-01-15T10:00:00.000Z',
      ...rest,
      messages: toMessageRecord(baseMessages),
      ids: baseIds,
    };
  };

  test('round-trip preserves empty conversation', () => {
    const original = createConversation([]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(parsed.id).toBe(original.id);
    expect(parsed.status).toBe(original.status);
    expect(parsed.metadata).toEqual(original.metadata);
    expect(getOrderedMessages(parsed)).toHaveLength(0);
    expect(parsed.createdAt).toBe(original.createdAt);
    expect(parsed.updatedAt).toBe(original.updatedAt);
  });

  test('round-trip preserves conversation with title', () => {
    const original = createConversation([], { title: 'Test Conversation' });
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(parsed.title).toBe(original.title);
  });

  test('round-trip preserves conversation metadata', () => {
    const original = createConversation([], {
      metadata: { key: 'value', nested: { a: 1, b: 'two' } },
    });
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(parsed.metadata).toEqual(original.metadata);
  });

  test('round-trip preserves conversation status', () => {
    const statuses = ['active', 'archived', 'deleted'] as const;
    for (const status of statuses) {
      const original = createConversation([], { status });
      const markdown = toMarkdown(original, { includeMetadata: true });
      const parsed = fromMarkdown(markdown);
      expect(parsed.status).toBe(status);
    }
  });

  test('round-trip preserves simple text message', () => {
    const original = createConversation([
      createMessage({ id: 'msg-1', content: 'Hello, world!' }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)).toHaveLength(1);
    expect(getOrderedMessages(parsed)[0].id).toBe('msg-1');
    expect(getOrderedMessages(parsed)[0].content).toBe('Hello, world!');
  });

  test('round-trip preserves all message roles', () => {
    const roles = [
      'user',
      'assistant',
      'system',
      'developer',
      'tool-use',
      'tool-result',
      'snapshot',
    ] as const;
    const messages = roles.map((role, i) =>
      createMessage({
        id: `msg-${i}`,
        role,
        content: `${role} message`,
        position: i,
        createdAt: `2024-01-15T10:0${i}:00.000Z`,
      }),
    );
    const original = createConversation(messages);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)).toHaveLength(7);
    for (let i = 0; i < roles.length; i++) {
      expect(getOrderedMessages(parsed)[i].role).toBe(roles[i]);
    }
  });

  test('round-trip preserves message metadata', () => {
    const original = createConversation([
      createMessage({
        metadata: { source: 'web', timestamp: 12345, nested: { x: [1, 2, 3] } },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0].metadata).toEqual(
      getOrderedMessages(original)[0].metadata,
    );
  });

  test('round-trip preserves hidden flag', () => {
    const original = createConversation([createMessage({ hidden: true })]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0].hidden).toBe(true);
  });

  test('round-trip preserves message positions', () => {
    const original = createConversation([
      createMessage({ id: 'msg-1', position: 0 }),
      createMessage({ id: 'msg-2', position: 1 }),
      createMessage({ id: 'msg-3', position: 2 }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0].position).toBe(0);
    expect(getOrderedMessages(parsed)[1].position).toBe(1);
    expect(getOrderedMessages(parsed)[2].position).toBe(2);
  });

  test('round-trip preserves message timestamps', () => {
    const original = createConversation([
      createMessage({ createdAt: '2024-06-15T14:30:45.123Z' }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0].createdAt).toBe('2024-06-15T14:30:45.123Z');
  });

  test('round-trip preserves toolCall', () => {
    const original = createConversation([
      createMessage({
        role: 'tool-use',
        toolCall: {
          id: 'call-123',
          name: 'search_documents',
          arguments: { query: 'test', limit: 10, filters: { type: 'pdf' } },
        },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0].toolCall).toEqual(
      getOrderedMessages(original)[0].toolCall,
    );
  });

  test('round-trip preserves toolResult', () => {
    const original = createConversation([
      createMessage({
        id: 'msg-1',
        role: 'tool-use',
        toolCall: {
          id: 'call-123',
          name: 'search_documents',
          arguments: { query: 'test' },
        },
      }),
      createMessage({
        id: 'msg-2',
        role: 'tool-result',
        position: 1,
        toolResult: {
          callId: 'call-123',
          outcome: 'error',
          content: { error: 'Not found', code: 404 },
        },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[1].toolResult).toEqual(
      getOrderedMessages(original)[1].toolResult,
    );
  });

  test('round-trip preserves tokenUsage', () => {
    const original = createConversation([
      createMessage({
        tokenUsage: { prompt: 100, completion: 200, total: 300 },
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0].tokenUsage).toEqual(
      getOrderedMessages(original)[0].tokenUsage,
    );
  });

  test('round-trip preserves goalCompleted', () => {
    const original = createConversation([
      createAssistantMessage({ goalCompleted: true }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    const message = getOrderedMessages(parsed)[0];
    expect(isAssistantMessage(message) && message.goalCompleted).toBe(true);
  });

  test('round-trip preserves multi-modal content with images', () => {
    const original = createConversation([
      createMessage({
        content: [
          { type: 'text', text: 'Check out this image:' },
          {
            type: 'image',
            url: 'https://example.com/photo.png',
            mimeType: 'image/png',
            text: 'A beautiful sunset',
          },
        ],
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    const content = getOrderedMessages(parsed)[0].content as MultiModalContent[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'Check out this image:' });
    expect(content[1]).toEqual({
      type: 'image',
      url: 'https://example.com/photo.png',
      mimeType: 'image/png',
      text: 'A beautiful sunset',
    });
  });

  test('round-trip preserves complex multi-modal content order', () => {
    const original = createConversation([
      createMessage({
        content: [
          { type: 'text', text: 'First text' },
          { type: 'image', url: 'https://example.com/1.png' },
          { type: 'text', text: 'Second text' },
          { type: 'image', url: 'https://example.com/2.png', mimeType: 'image/png' },
          { type: 'text', text: 'Third text' },
        ],
      }),
    ]);
    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    expect(getOrderedMessages(parsed)[0].content).toEqual(
      getOrderedMessages(original)[0].content,
    );
  });

  test('round-trip preserves complete complex conversation', () => {
    const originalMessages: ConversationMessage[] = [
      {
        id: 'msg-sys',
        role: 'system',
        content: 'You are a helpful assistant.',
        position: 0,
        createdAt: '2024-01-15T10:00:00.000Z',
        metadata: {},
        hidden: true,
      },
      {
        id: 'msg-user-1',
        role: 'user',
        content: [
          { type: 'text', text: 'Can you analyze this receipt?' },
          {
            type: 'image',
            url: 'https://example.com/receipt.jpg',
            mimeType: 'image/jpeg',
            text: 'Receipt image',
          },
        ],
        position: 1,
        createdAt: '2024-01-15T10:01:00.000Z',
        metadata: { source: 'mobile-app' },
        hidden: false,
      },
      {
        id: 'msg-tool-use',
        role: 'tool-use',
        content: 'Analyzing image...',
        position: 2,
        createdAt: '2024-01-15T10:01:05.000Z',
        metadata: {},
        hidden: false,
        toolCall: { id: 'call-ocr', name: 'analyze_image', arguments: { mode: 'ocr' } },
      },
      {
        id: 'msg-tool-result',
        role: 'tool-result',
        content: 'OCR completed',
        position: 3,
        createdAt: '2024-01-15T10:01:10.000Z',
        metadata: {},
        hidden: false,
        toolResult: {
          callId: 'call-ocr',
          outcome: 'success',
          content: { text: 'Total: $42.50', confidence: 0.98 },
        },
      },
      {
        id: 'msg-assistant',
        role: 'assistant',
        content: 'The receipt shows a total of $42.50.',
        position: 4,
        createdAt: '2024-01-15T10:01:15.000Z',
        metadata: { model: 'gpt-4' },
        hidden: false,
        tokenUsage: { prompt: 150, completion: 30, total: 180 },
        goalCompleted: true,
      },
    ];

    const original: Conversation = {
      schemaVersion: 1,
      id: 'conv-complex-123',
      title: 'Complex Test Conversation',
      status: 'archived',
      metadata: { department: 'support', priority: 'high' },
      ids: originalMessages.map((message) => message.id),
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: '2024-01-15T12:30:00.000Z',
      messages: toMessageRecord(originalMessages),
    };

    const markdown = toMarkdown(original, { includeMetadata: true });
    const parsed = fromMarkdown(markdown);

    // Verify conversation-level properties
    expect(parsed.id).toBe(original.id);
    expect(parsed.title).toBe(original.title);
    expect(parsed.status).toBe(original.status);
    expect(parsed.metadata).toEqual(original.metadata);
    expect(parsed.createdAt).toBe(original.createdAt);
    expect(parsed.updatedAt).toBe(original.updatedAt);

    // Verify message count
    expect(getOrderedMessages(parsed)).toHaveLength(5);

    // Verify each message
    for (let i = 0; i < getOrderedMessages(original).length; i++) {
      const originalMsg = getOrderedMessages(original)[i];
      const parsedMsg = getOrderedMessages(parsed)[i];

      expect(parsedMsg.id).toBe(originalMsg.id);
      expect(parsedMsg.role).toBe(originalMsg.role);
      expect(parsedMsg.position).toBe(originalMsg.position);
      expect(parsedMsg.createdAt).toBe(originalMsg.createdAt);
      expect(parsedMsg.metadata).toEqual(originalMsg.metadata);
      expect(parsedMsg.hidden).toBe(originalMsg.hidden);
      expect(parsedMsg.toolCall).toEqual(originalMsg.toolCall);
      expect(parsedMsg.toolResult).toEqual(originalMsg.toolResult);
      expect(parsedMsg.tokenUsage).toEqual(originalMsg.tokenUsage);
      if (isAssistantMessage(originalMsg)) {
        expect(isAssistantMessage(parsedMsg)).toBe(true);
        if (isAssistantMessage(parsedMsg)) {
          expect(parsedMsg.goalCompleted).toBe(originalMsg.goalCompleted);
        }
      }

      // Content comparison
      if (Array.isArray(originalMsg.content)) {
        expect(parsedMsg.content).toEqual(originalMsg.content);
      } else {
        expect(parsedMsg.content).toBe(originalMsg.content);
      }
    }
  });
});

describe('role labels', () => {
  describe('ROLE_LABELS', () => {
    test('exports all message roles', () => {
      const roles: MessageRole[] = [
        'user',
        'assistant',
        'system',
        'developer',
        'tool-use',
        'tool-result',
        'snapshot',
      ];

      for (const role of roles) {
        expect(ROLE_LABELS[role]).toBeDefined();
        expect(typeof ROLE_LABELS[role]).toBe('string');
      }
    });

    test('has correct labels for each role', () => {
      expect(ROLE_LABELS.user).toBe('User');
      expect(ROLE_LABELS.assistant).toBe('Assistant');
      expect(ROLE_LABELS.system).toBe('System');
      expect(ROLE_LABELS.developer).toBe('Developer');
      expect(ROLE_LABELS['tool-use']).toBe('Tool Use');
      expect(ROLE_LABELS['tool-result']).toBe('Tool Result');
      expect(ROLE_LABELS.snapshot).toBe('Snapshot');
    });
  });

  describe('LABEL_TO_ROLE', () => {
    test('provides inverse mapping of ROLE_LABELS', () => {
      for (const [role, label] of Object.entries(ROLE_LABELS) as Array<
        [MessageRole, string]
      >) {
        expect(LABEL_TO_ROLE[label]).toBe(role);
      }
    });

    test('has correct roles for each label', () => {
      expect(LABEL_TO_ROLE['User']).toBe('user');
      expect(LABEL_TO_ROLE['Assistant']).toBe('assistant');
      expect(LABEL_TO_ROLE['System']).toBe('system');
      expect(LABEL_TO_ROLE['Developer']).toBe('developer');
      expect(LABEL_TO_ROLE['Tool Use']).toBe('tool-use');
      expect(LABEL_TO_ROLE['Tool Result']).toBe('tool-result');
      expect(LABEL_TO_ROLE['Snapshot']).toBe('snapshot');
    });
  });

  describe('getRoleLabel', () => {
    test('returns correct label for each role', () => {
      expect(getRoleLabel('user')).toBe('User');
      expect(getRoleLabel('assistant')).toBe('Assistant');
      expect(getRoleLabel('system')).toBe('System');
      expect(getRoleLabel('developer')).toBe('Developer');
      expect(getRoleLabel('tool-use')).toBe('Tool Use');
      expect(getRoleLabel('tool-result')).toBe('Tool Result');
      expect(getRoleLabel('snapshot')).toBe('Snapshot');
    });
  });

  describe('getRoleFromLabel', () => {
    test('returns correct role for each label', () => {
      expect(getRoleFromLabel('User')).toBe('user');
      expect(getRoleFromLabel('Assistant')).toBe('assistant');
      expect(getRoleFromLabel('System')).toBe('system');
      expect(getRoleFromLabel('Developer')).toBe('developer');
      expect(getRoleFromLabel('Tool Use')).toBe('tool-use');
      expect(getRoleFromLabel('Tool Result')).toBe('tool-result');
      expect(getRoleFromLabel('Snapshot')).toBe('snapshot');
    });

    test('returns undefined for unknown labels', () => {
      expect(getRoleFromLabel('Unknown')).toBeUndefined();
      expect(getRoleFromLabel('')).toBeUndefined();
      expect(getRoleFromLabel('user')).toBeUndefined(); // lowercase, not valid
      expect(getRoleFromLabel('ASSISTANT')).toBeUndefined(); // uppercase, not valid
    });
  });
});
