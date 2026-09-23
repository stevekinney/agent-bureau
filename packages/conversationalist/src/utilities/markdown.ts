import { dump } from 'js-yaml';

import { assertConversationSafe } from '../conversation/validation';
import type { MultiModalContent } from '../multi-modal';
import { copyMultiModalContent, renderDocumentReferenceText } from '../multi-modal';
import type {
  ConversationHistory as Conversation,
  ConversationStatus,
  JSONValue,
  Message,
  TokenUsage,
  ToMarkdownOptions,
  ToolCall,
  ToolResult,
} from '../types';
import { ROLE_LABELS } from './markdown-roles';
import { prepareConversationForMarkdown, resolveMarkdownOptions } from './markdown-sanitization';
import { isAssistantMessage, messageParts } from './message';
import { getOrderedMessages } from './message-store';

/**
 * Formats a message's content for markdown output.
 * Text parts are appended in order, images are rendered as markdown image syntax on their own lines.
 */
function formatMessageContent(message: Message): string {
  if (typeof message.content === 'string') return message.content;

  const parts = messageParts(message);
  const lines: string[] = [];

  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      lines.push(part.text);
    } else if (part.type === 'image') {
      const imageUrl = part.url;
      const altText = part.text ?? 'image';
      lines.push(`![${altText}](${imageUrl})`);
    } else if (part.type === 'document') {
      lines.push(renderDocumentReferenceText(part));
    }
  }

  return lines.join('\n\n');
}

/**
 * Metadata stored for each message in the YAML frontmatter.
 * Content is only included for multi-modal messages to preserve image metadata.
 */
interface MessageFrontmatter {
  position: number;
  createdAt: string;
  metadata: Record<string, JSONValue>;
  hidden: boolean;
  content?: MultiModalContent[];
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  tokenUsage?: TokenUsage;
  goalCompleted?: boolean;
  cacheBoundary?: boolean;
}

/**
 * Metadata stored in YAML frontmatter for conversation-level data.
 */
interface ConversationFrontmatter {
  schemaVersion?: number;
  id: string;
  title?: string;
  status: ConversationStatus;
  metadata: Record<string, JSONValue>;
  createdAt: string;
  updatedAt: string;
  messages: Record<string, MessageFrontmatter>;
}

/**
 * Converts a conversation to a Markdown string representation.
 *
 * By default, outputs clean, human-readable markdown with:
 * - Each message with a header containing only the role: `### Role`
 * - Message content rendered as markdown
 *
 * When `options.includeMetadata` is `true`, outputs markdown with full metadata
 * for lossless round-trip conversion:
 * - YAML frontmatter with conversation metadata and all message metadata keyed by message ID
 * - Headers include message ID: `### Role (msg-id)`
 * - Full content array preserved for multi-modal messages
 *
 * For multi-modal content:
 * - Text parts are appended in order
 * - Image parts are rendered as `![alt]({url})` on their own line
 *
 * @param conversation - The conversation to convert
 * @param options - Options for markdown output
 * @returns A Markdown string representation of the conversation
 */
export function toMarkdown(conversation: Conversation, options: ToMarkdownOptions = {}): string {
  assertConversationSafe(conversation);
  const resolved = resolveMarkdownOptions(options);
  const prepared = prepareConversationForMarkdown(conversation, resolved);

  if (resolved.includeMetadata) {
    return toMarkdownWithMetadata(prepared);
  }

  return toMarkdownSimple(prepared);
}

/**
 * Outputs simple, human-readable markdown without metadata.
 */
function toMarkdownSimple(conversation: Conversation): string {
  const sections: string[] = [];

  for (const message of getOrderedMessages(conversation)) {
    const roleName = ROLE_LABELS[message.role];
    const header = `### ${roleName}`;
    const content = formatMessageContent(message);
    sections.push(`${header}\n\n${content}`);
  }

  return sections.join('\n\n');
}

/**
 * Outputs markdown with full metadata for lossless round-trip conversion.
 */
function toMarkdownWithMetadata(conversation: Conversation): string {
  // Build messages metadata map
  const messagesMetadata: Record<string, MessageFrontmatter> = {};

  for (const message of getOrderedMessages(conversation)) {
    messagesMetadata[message.id] = messageFrontmatter(message);
  }

  const frontmatterData: ConversationFrontmatter = {
    schemaVersion: conversation.schemaVersion,
    id: conversation.id,
    status: conversation.status,
    metadata: { ...conversation.metadata },
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: messagesMetadata,
  };

  // Only add title if it's defined
  if (conversation.title !== undefined) {
    frontmatterData.title = conversation.title;
  }

  // Build message body
  const messageSections: string[] = [];

  for (const message of getOrderedMessages(conversation)) {
    const roleName = ROLE_LABELS[message.role];
    const header = `### ${roleName} (${message.id})`;
    const content = formatMessageContent(message);
    messageSections.push(`${header}\n\n${content}`);
  }

  const body = messageSections.join('\n\n');

  // Use gray-matter to stringify with YAML frontmatter
  return `---\n${dump(frontmatterData).trim()}\n---\n${body}\n`;
}

function messageFrontmatter(message: Message): MessageFrontmatter {
  const messageMeta: MessageFrontmatter = {
    position: message.position,
    createdAt: message.createdAt,
    metadata: { ...message.metadata },
    hidden: message.hidden,
  };

  // Include content in metadata only for multi-modal messages
  if (typeof message.content !== 'string') {
    messageMeta.content = message.content.map(copyMultiModalContent);
  }

  if (message.toolCall) {
    messageMeta.toolCall = { ...message.toolCall };
  }
  if (message.toolResult) {
    messageMeta.toolResult = { ...message.toolResult };
  }
  if (message.tokenUsage) {
    messageMeta.tokenUsage = { ...message.tokenUsage };
  }
  if (isAssistantMessage(message) && message.goalCompleted !== undefined) {
    messageMeta.goalCompleted = message.goalCompleted;
  }
  if (message.cacheBoundary !== undefined) {
    messageMeta.cacheBoundary = message.cacheBoundary;
  }

  return messageMeta;
}
