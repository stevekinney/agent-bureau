import type {
  Message as HomogenaizeMessage,
  MessageRole as HomogenaizeMessageRole,
  MultiModalContent as HomogenaizeMultiModalContent,
  TextContent as HomogenaizeTextContent,
  ToolCall as HomogenaizeToolCall,
} from '@lasercat/homogenaize';
import { describe, expectTypeOf, it } from 'bun:test';

import type {
  ExternalMessage,
  ImageContent,
  MultiModalContent,
  TextContent,
} from '../src';
import type { MessageInput, MessageRole, ToolCall } from '../src/types';

describe('homogenaize type compatibility', () => {
  it('accepts homogenaize roles and messages', () => {
    expectTypeOf<HomogenaizeMessageRole>().toMatchTypeOf<MessageRole>();
    expectTypeOf<HomogenaizeMessage>().toMatchTypeOf<MessageInput>();
  });

  it('aligns multi-modal content types', () => {
    expectTypeOf<HomogenaizeMultiModalContent>().toMatchTypeOf<MultiModalContent>();
    expectTypeOf<MultiModalContent>().toMatchTypeOf<HomogenaizeMultiModalContent>();
    expectTypeOf<TextContent>().toMatchTypeOf<HomogenaizeMultiModalContent>();
    expectTypeOf<ImageContent>().toMatchTypeOf<HomogenaizeMultiModalContent>();
  });

  it('aligns tool call shapes', () => {
    expectTypeOf<ToolCall>().toMatchTypeOf<HomogenaizeToolCall>();
  });

  it('external message matches homogenaize message', () => {
    expectTypeOf<ExternalMessage>().toMatchTypeOf<HomogenaizeMessage>();
    expectTypeOf<HomogenaizeMessage>().toMatchTypeOf<ExternalMessage>();
  });

  it('text content remains compatible with message content', () => {
    expectTypeOf<HomogenaizeTextContent>().toMatchTypeOf<MessageInput['content']>();
  });
});
