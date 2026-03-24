import { z } from 'zod';

import type { SessionInfo, SessionPersistenceAdapter } from '../environment';
import { conversationShape } from '../schemas';
import type { ConversationHistory } from '../types';

/**
 * Lenient conversation schema that tolerates extra keys from older/newer schema versions.
 */
const lenientConversationSchema = z.object(conversationShape).passthrough();

export interface RedisPersistenceAdapterOptions {
  client?: import('bun').RedisClient;
  url?: string;
  keyPrefix?: string;
  timeToLive?: number;
}

export interface RedisPersistenceAdapter extends SessionPersistenceAdapter {
  close(): void;
}

const KEY_PREFIX_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_KEY_PREFIX_LENGTH = 128;

function validateKeyPrefix(prefix: string): void {
  if (prefix.length > MAX_KEY_PREFIX_LENGTH || !KEY_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `Invalid key prefix "${prefix}": must match ${KEY_PREFIX_PATTERN.source} and be at most ${MAX_KEY_PREFIX_LENGTH} characters`,
    );
  }
}

export async function createRedisPersistenceAdapter(
  options: RedisPersistenceAdapterOptions = {},
): Promise<RedisPersistenceAdapter> {
  const { RedisClient } = await import('bun');
  const keyPrefix = options.keyPrefix ?? 'sessions';
  validateKeyPrefix(keyPrefix);

  const ownsClient = !options.client;
  /* v8 ignore next */
  const client =
    options.client ??
    new RedisClient(options.url ?? Bun.env['REDIS_URL'] ?? 'redis://localhost:6379');

  const timeToLive = options.timeToLive;
  const indexKey = `${keyPrefix}:_index`;

  function sessionKey(id: string): string {
    return `${keyPrefix}:${id}`;
  }

  return {
    async save(conversation: ConversationHistory): Promise<void> {
      const tags = (conversation.metadata['_tags'] as string[] | undefined) ?? [];
      const key = sessionKey(conversation.id);

      await client.send('HSET', [
        key,
        'data',
        JSON.stringify(conversation),
        'title',
        conversation.title ?? '',
        'created_at',
        conversation.createdAt,
        'updated_at',
        conversation.updatedAt,
        'message_count',
        String(conversation.ids.length),
        'tags',
        JSON.stringify(tags),
      ]);

      await client.send('SADD', [indexKey, conversation.id]);

      if (timeToLive !== undefined) {
        await client.send('EXPIRE', [key, String(timeToLive)]);
      }
    },

    async load(id: string): Promise<ConversationHistory | undefined> {
      const data = (await client.send('HGET', [sessionKey(id), 'data'])) as string | null;
      if (!data) return undefined;

      const parsed: unknown = JSON.parse(data);
      const result = lenientConversationSchema.safeParse(parsed);
      if (!result.success) return undefined;
      return result.data as ConversationHistory;
    },

    async list(): Promise<SessionInfo[]> {
      const ids = (await client.send('SMEMBERS', [indexKey])) as string[];
      const sessions: SessionInfo[] = [];

      for (const id of ids) {
        const fields = (await client.send('HMGET', [
          sessionKey(id),
          'title',
          'created_at',
          'updated_at',
          'message_count',
          'tags',
        ])) as (string | null)[];

        const [title, createdAt, updatedAt, messageCount, tags] = fields;

        // Hash expired but index entry remains — clean up and skip
        if (createdAt === null) {
          await client.send('SREM', [indexKey, id]);
          continue;
        }

        sessions.push({
          id,
          ...(title ? { title } : {}),
          tags: tags ? (JSON.parse(tags) as string[]) : [],
          createdAt: createdAt!,
          updatedAt: updatedAt!,
          messageCount: Number(messageCount),
        });
      }

      return sessions;
    },

    async delete(id: string): Promise<void> {
      await client.send('DEL', [sessionKey(id)]);
      await client.send('SREM', [indexKey, id]);
    },

    close(): void {
      /* v8 ignore next */
      if (ownsClient) client.close();
    },
  };
}
