import { load } from 'js-yaml';

import { assertConversationSafe } from '../conversation/validation';
import { type ConversationRuntime, defaultConversationRuntime } from '../environment';
import { conversationSchema } from '../schemas';
import { type ConversationHistory, type Message, CURRENT_SCHEMA_VERSION } from '../types';
import { getRoleFromLabel } from './markdown-roles';
import { toIdRecord } from './message-store';
import { toReadonly } from './type-helpers';

/** A malformed Markdown conversation or its YAML metadata. */
export class MarkdownParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkdownParseError';
  }
}

/** Parses YAML-backed or plain Markdown, validating the complete conversation. */
export function fromMarkdown(
  markdown: string,
  runtime: ConversationRuntime = defaultConversationRuntime,
): ConversationHistory {
  const trimmed = markdown.trim();
  const candidate = trimmed.startsWith('---')
    ? parseMarkdownWithMetadata(trimmed)
    : parseMarkdownSimple(trimmed, runtime);
  try {
    const conversation = conversationSchema.parse(candidate);
    assertConversationSafe(conversation);
    return toReadonly(conversation);
  } catch (error) {
    throw new MarkdownParseError(
      `Invalid markdown conversation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFrontmatter(markdown: string): { metadata: Record<string, unknown>; body: string } {
  const match = /^---(?:yaml|yml)?[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(markdown);
  if (!match || match.index !== 0) {
    throw new MarkdownParseError('Invalid frontmatter: expected a complete YAML block');
  }
  let metadata: unknown;
  try {
    metadata = load(match[1] ?? '');
  } catch {
    throw new MarkdownParseError('Invalid frontmatter: failed to parse YAML');
  }
  return {
    metadata: isRecord(metadata) ? metadata : {},
    body: markdown.slice(match[0].length).trim(),
  };
}

function normalizeToolFields(
  value: unknown,
  oldKey: 'args' | 'result',
  key: 'arguments' | 'content',
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized = { ...value };
  if (normalized[key] === undefined && normalized[oldKey] !== undefined) {
    normalized[key] = normalized[oldKey];
  }
  delete normalized[oldKey];
  return normalized;
}

function normalizeMarkdownToolCall(value: unknown): unknown {
  const record = normalizeToolFields(value, 'args', 'arguments');
  if (
    !record ||
    typeof record['id'] !== 'string' ||
    typeof record['name'] !== 'string' ||
    record['arguments'] === undefined
  )
    return undefined;
  return { id: record['id'], name: record['name'], arguments: record['arguments'] };
}

function normalizeMarkdownToolResult(value: unknown): unknown {
  const record = normalizeToolFields(value, 'result', 'content');
  if (!record || typeof record['callId'] !== 'string' || record['content'] === undefined)
    return undefined;
  if (
    record['outcome'] !== 'success' &&
    record['outcome'] !== 'error' &&
    record['outcome'] !== 'action_required'
  )
    return undefined;
  return {
    callId: record['callId'],
    outcome: record['outcome'],
    content: record['content'],
    error: record['error'],
    action: record['action'],
    ...(typeof record['inputDigest'] === 'string' ? { inputDigest: record['inputDigest'] } : {}),
    ...(typeof record['outputDigest'] === 'string' ? { outputDigest: record['outputDigest'] } : {}),
  };
}

function readMetadataMessage(
  match: RegExpExecArray,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const [, roleDisplay = '', messageId = '', contentBody = ''] = match;
  const role = getRoleFromLabel(roleDisplay);
  if (!role) throw new MarkdownParseError(`Unknown role: ${roleDisplay}`);
  const allMetadata = metadata['messages'];
  const messageMetadata = isRecord(allMetadata) ? allMetadata[messageId] : undefined;
  if (!isRecord(messageMetadata)) {
    throw new MarkdownParseError(`Missing metadata for message: ${messageId}`);
  }
  return {
    id: messageId,
    role,
    content: messageMetadata['content'] ?? contentBody.trim(),
    position: messageMetadata['position'],
    createdAt: messageMetadata['createdAt'],
    metadata: messageMetadata['metadata'] ?? {},
    hidden: messageMetadata['hidden'],
    toolCall: normalizeMarkdownToolCall(messageMetadata['toolCall']),
    toolResult: normalizeMarkdownToolResult(messageMetadata['toolResult']),
    tokenUsage: messageMetadata['tokenUsage'],
    cacheBoundary: messageMetadata['cacheBoundary'],
    ...(role === 'assistant' ? { goalCompleted: messageMetadata['goalCompleted'] } : {}),
  };
}

function parseMarkdownWithMetadata(markdown: string): unknown {
  const { metadata, body } = readFrontmatter(markdown);
  if (!metadata['id']) {
    throw new MarkdownParseError('Invalid frontmatter: missing required field "id"');
  }
  const pattern = /^### ([\w\s]+) \(([^)]+)\)\n\n([\s\S]*?)(?=\n\n### |\n*$)/gm;
  const messages = [...body.matchAll(pattern)].map((match) => readMetadataMessage(match, metadata));
  return {
    schemaVersion: metadata['schemaVersion'] ?? CURRENT_SCHEMA_VERSION,
    id: metadata['id'],
    title: metadata['title'],
    status: metadata['status'] ?? 'active',
    metadata: metadata['metadata'] ?? {},
    ids: messages.map((message) => message['id']),
    messages: Object.fromEntries(messages.map((message) => [String(message['id']), message])),
    createdAt: metadata['createdAt'],
    updatedAt: metadata['updatedAt'],
  };
}

function parseMarkdownSimple(body: string, runtime: ConversationRuntime): ConversationHistory {
  const now = runtime.clock.nowISO();
  const pattern = /^### ([^\n]+)\n\n([\s\S]*?)(?=\n\n### |\n*$)/gm;
  const messages = [...body.matchAll(pattern)].map((match, position): Message => {
    const [, roleDisplay = '', contentBody = ''] = match;
    const role = getRoleFromLabel(roleDisplay);
    if (!role) throw new MarkdownParseError(`Unknown role: ${roleDisplay}`);
    return {
      id: runtime.identifiers.next('conversation'),
      role,
      content: contentBody.trim(),
      position,
      createdAt: now,
      metadata: {},
      hidden: false,
    };
  });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: runtime.identifiers.next('conversation'),
    status: 'active',
    metadata: {},
    ids: messages.map((message) => message.id),
    messages: toIdRecord(messages),
    createdAt: now,
    updatedAt: now,
  };
}
