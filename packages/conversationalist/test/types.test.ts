import { describe, expectTypeOf, it } from 'bun:test';

import { ConversationHistory } from '../src/history';
import type { MultiModalContent } from '../src/multi-modal';
import type {
  AssistantMessage,
  Conversation,
  ConversationStatus,
  JSONValue,
  Message,
  MessageInput,
  MessageRole,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../src/types';

describe('conversationalist types Type Inference', () => {
  describe('ConversationHistory', () => {
    it('implements EventTarget', () => {
      expectTypeOf<ConversationHistory>().toMatchTypeOf<EventTarget>();
    });
  });

  describe('MessageRole', () => {
    it('is a union of literal string types', () => {
      expectTypeOf<MessageRole>().toEqualTypeOf<
        | 'user'
        | 'assistant'
        | 'system'
        | 'developer'
        | 'tool-use'
        | 'tool-result'
        | 'snapshot'
      >();
    });
  });

  describe('ToolCall', () => {
    it('has required properties', () => {
      expectTypeOf<ToolCall['id']>().toEqualTypeOf<string>();
      expectTypeOf<ToolCall['name']>().toEqualTypeOf<string>();
      expectTypeOf<ToolCall['arguments']>().toEqualTypeOf<JSONValue>();
    });

    it('rejects non-JSON arguments at compile time', () => {
      const badCall: ToolCall = {
        id: 'call-1',
        name: 'tool',
        // @ts-expect-error - functions are not JSONValue
        arguments: () => 1,
      };
      void badCall;
    });
  });

  describe('ToolResult', () => {
    it('has required properties', () => {
      expectTypeOf<ToolResult['callId']>().toEqualTypeOf<string>();
      expectTypeOf<ToolResult['outcome']>().toEqualTypeOf<'success' | 'error'>();
      expectTypeOf<ToolResult['content']>().toEqualTypeOf<JSONValue>();
    });

    it('rejects non-JSON content at compile time', () => {
      const badResult: ToolResult = {
        callId: 'call-1',
        outcome: 'success',
        // @ts-expect-error - Date is not JSONValue
        content: new Date(),
      };
      void badResult;
    });

    it('outcome is a discriminated union', () => {
      const success: ToolResult = {
        callId: 'call-1',
        outcome: 'success',
        content: 'data',
      };
      const error: ToolResult = {
        callId: 'call-1',
        outcome: 'error',
        content: 'Error message',
      };

      expectTypeOf(success.outcome).toEqualTypeOf<'success' | 'error'>();
      expectTypeOf(error.outcome).toEqualTypeOf<'success' | 'error'>();
    });
  });

  describe('TokenUsage', () => {
    it('has required numeric properties', () => {
      expectTypeOf<TokenUsage['prompt']>().toEqualTypeOf<number>();
      expectTypeOf<TokenUsage['completion']>().toEqualTypeOf<number>();
      expectTypeOf<TokenUsage['total']>().toEqualTypeOf<number>();
    });
  });

  describe('MessageInput', () => {
    it('has required properties', () => {
      expectTypeOf<MessageInput['role']>().toEqualTypeOf<MessageRole>();
      expectTypeOf<MessageInput['content']>().toEqualTypeOf<
        string | MultiModalContent[]
      >();
    });

    it('has optional properties', () => {
      expectTypeOf<MessageInput['metadata']>().toEqualTypeOf<
        Record<string, JSONValue> | undefined
      >();
      expectTypeOf<MessageInput['hidden']>().toEqualTypeOf<boolean | undefined>();
      expectTypeOf<MessageInput['toolCall']>().toEqualTypeOf<ToolCall | undefined>();
      expectTypeOf<MessageInput['toolResult']>().toEqualTypeOf<ToolResult | undefined>();
      expectTypeOf<MessageInput['tokenUsage']>().toEqualTypeOf<TokenUsage | undefined>();
      expectTypeOf<MessageInput['goalCompleted']>().toEqualTypeOf<boolean | undefined>();
    });
  });

  describe('Message', () => {
    it('has required properties with readonly modifiers', () => {
      expectTypeOf<Message['id']>().toEqualTypeOf<string>();
      expectTypeOf<Message['role']>().toEqualTypeOf<MessageRole>();
      expectTypeOf<Message['position']>().toEqualTypeOf<number>();
      expectTypeOf<Message['createdAt']>().toEqualTypeOf<string>();
      expectTypeOf<Message['hidden']>().toEqualTypeOf<boolean>();
    });

    it('has content as string or readonly array', () => {
      // Content is either string or ReadonlyArray<MultiModalContent>
      expectTypeOf<Message['content']>().toEqualTypeOf<
        string | ReadonlyArray<MultiModalContent>
      >();
    });

    it('has readonly metadata', () => {
      expectTypeOf<Message['metadata']>().toEqualTypeOf<
        Readonly<Record<string, JSONValue>>
      >();
    });

    it('has optional readonly tool properties', () => {
      expectTypeOf<Message['toolCall']>().toEqualTypeOf<Readonly<ToolCall> | undefined>();
      expectTypeOf<Message['toolResult']>().toEqualTypeOf<
        Readonly<ToolResult> | undefined
      >();
      expectTypeOf<Message['tokenUsage']>().toEqualTypeOf<
        Readonly<TokenUsage> | undefined
      >();
    });
  });

  describe('AssistantMessage', () => {
    it('sets the role to assistant and exposes goalCompleted', () => {
      expectTypeOf<AssistantMessage['role']>().toEqualTypeOf<'assistant'>();
      expectTypeOf<AssistantMessage['goalCompleted']>().toEqualTypeOf<
        boolean | undefined
      >();
    });
  });

  describe('ConversationStatus', () => {
    it('is a union of literal string types', () => {
      expectTypeOf<ConversationStatus>().toEqualTypeOf<
        'active' | 'archived' | 'deleted'
      >();
    });
  });

  describe('Conversation', () => {
    it('has required properties', () => {
      expectTypeOf<Conversation['schemaVersion']>().toEqualTypeOf<number>();
      expectTypeOf<Conversation['id']>().toEqualTypeOf<string>();
      expectTypeOf<Conversation['status']>().toEqualTypeOf<ConversationStatus>();
      expectTypeOf<Conversation['createdAt']>().toEqualTypeOf<string>();
      expectTypeOf<Conversation['updatedAt']>().toEqualTypeOf<string>();
    });

    it('has readonly nested types', () => {
      // Metadata is readonly
      expectTypeOf<Conversation['metadata']>().toEqualTypeOf<
        Readonly<Record<string, JSONValue>>
      >();

      // Ids are readonly
      expectTypeOf<Conversation['ids']>().toEqualTypeOf<ReadonlyArray<string>>();

      // Messages are readonly
      expectTypeOf<Conversation['messages']>().toEqualTypeOf<
        Readonly<Record<string, Message>>
      >();
    });

    it('has optional title', () => {
      expectTypeOf<Conversation['title']>().toEqualTypeOf<string | undefined>();
    });

    it('is immutable (all nested arrays are readonly)', () => {
      // This verifies that the Conversation type enforces immutability
      const conv: Conversation = {
        schemaVersion: 1,
        id: 'conv-1',
        status: 'active',
        metadata: {},
        ids: [],
        messages: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // @ts-expect-error - ids is readonly
      conv.ids.push('msg-1');

      // @ts-expect-error - messages is readonly
      conv.messages['msg-1'] = {} as Message;

      // @ts-expect-error - cannot reassign readonly property
      conv.metadata['key'] = 'value';

      // Just to verify the test compiles (the errors above are expected)
      expectTypeOf(conv).toMatchTypeOf<Conversation>();
    });
  });
});
