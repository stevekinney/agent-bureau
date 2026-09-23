import type { Message } from '../types';
import type { CompactionOptions } from './types';

export function calculateChunkSize(
  totalTokens: number,
  averageMessageTokens: number,
  contextWindow: number,
  options?: CompactionOptions,
): number {
  const baseRatio = options?.baseChunkRatio ?? 0.4;
  const minRatio = options?.minimumChunkRatio ?? 0.15;
  const safety = options?.safetyMargin ?? 1.2;
  const ratio = averageMessageTokens > contextWindow * 0.1 ? minRatio : baseRatio;
  return Math.max(1, Math.floor((totalTokens * ratio) / safety));
}

function pairMessages(messages: readonly Message[]): Message[][] {
  const pairs: Message[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const next = messages[index + 1];
    const isPair =
      message.role === 'tool-call' &&
      message.toolCall &&
      next?.role === 'tool-result' &&
      next.toolResult?.callId === message.toolCall.id;
    if (isPair) {
      pairs.push([message, next]);
      index++;
    } else pairs.push([message]);
  }
  return pairs;
}

export function chunkMessages(
  messages: Message[],
  chunkTokenBudget: number,
  estimator: (message: Message) => number,
): Message[][] {
  if (messages.length === 0) return [];
  const chunks: Message[][] = [];
  let currentChunk: Message[] = [];
  let currentTokens = 0;
  for (const pairedMessages of pairMessages(messages)) {
    const pairedTokens = pairedMessages.reduce((sum, message) => sum + estimator(message), 0);
    if (currentTokens + pairedTokens > chunkTokenBudget && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(...pairedMessages);
    currentTokens += pairedTokens;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}
