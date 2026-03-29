import type { KeyValueStore } from 'storage';

import { extractKeyId, generateApiKey, hashApiKey, verifyApiKey } from './key-utilities';
import type { ApiKey, ApiKeyStore, CreateApiKeyOptions } from './types';

const KEY_PREFIX = 'api-key:';

/** Returns true if the value is a string that parses to a valid Date. */
function isValidDate(value: unknown): boolean {
  return typeof value === 'string' && !isNaN(new Date(value).getTime());
}

/** Safely parse a stored JSON string into an ApiKey, returning undefined on corruption. */
function parseApiKey(raw: string): ApiKey | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      'name' in parsed &&
      'keyHash' in parsed &&
      'active' in parsed &&
      'createdAt' in parsed &&
      isValidDate((parsed as Record<string, unknown>)['createdAt'])
    ) {
      return parsed as ApiKey;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates an API key store backed by a `KeyValueStore`. Keys are stored under
 * the `api-key:<id>` prefix. Plaintext keys are never persisted; only their
 * SHA-256 hashes are stored.
 */
export function createApiKeyStore(kv: KeyValueStore): ApiKeyStore {
  async function create(options: CreateApiKeyOptions): Promise<{ key: ApiKey; plaintext: string }> {
    const plaintext = generateApiKey();
    const id = extractKeyId(plaintext);
    const keyHash = await hashApiKey(plaintext);

    const key: ApiKey = {
      id,
      name: options.name,
      keyHash,
      scopes: options.scopes ?? [],
      createdAt: new Date().toISOString(),
      expiresAt: options.expiresAt,
      active: true,
    };

    await kv.set(`${KEY_PREFIX}${id}`, JSON.stringify(key));

    return { key, plaintext };
  }

  async function verify(token: string): Promise<ApiKey | null> {
    const id = extractKeyId(token);
    const raw = await kv.get(`${KEY_PREFIX}${id}`);
    if (!raw) return null;

    const key = parseApiKey(raw);
    if (!key) return null;

    if (!key.active) return null;

    if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    const matches = await verifyApiKey(token, key.keyHash);
    if (!matches) return null;

    // Update lastUsedAt
    key.lastUsedAt = new Date().toISOString();
    await kv.set(`${KEY_PREFIX}${id}`, JSON.stringify(key));

    return key;
  }

  async function revoke(id: string): Promise<void> {
    const raw = await kv.get(`${KEY_PREFIX}${id}`);
    if (!raw) return;

    const key = parseApiKey(raw);
    if (!key) return;
    key.active = false;
    await kv.set(`${KEY_PREFIX}${id}`, JSON.stringify(key));
  }

  async function list(): Promise<ApiKey[]> {
    const keys = await kv.list(KEY_PREFIX);
    const results: ApiKey[] = [];

    for (const storageKey of keys) {
      const raw = await kv.get(storageKey);
      if (!raw) continue;

      const key = parseApiKey(raw);
      if (!key) continue;
      // Strip the hash before returning
      results.push({ ...key, keyHash: '' });
    }

    return results;
  }

  async function rotate(id: string): Promise<{ key: ApiKey; plaintext: string }> {
    const raw = await kv.get(`${KEY_PREFIX}${id}`);
    if (!raw) {
      throw new Error(`API key not found: ${id}`);
    }

    const oldKey = parseApiKey(raw);
    if (!oldKey) {
      throw new Error(`API key data corrupted: ${id}`);
    }

    // Revoke the old key
    await revoke(id);

    // Create a new key with the same name and scopes
    return create({
      name: oldKey.name,
      scopes: oldKey.scopes,
      expiresAt: oldKey.expiresAt,
    });
  }

  return { create, verify, revoke, list, rotate };
}
