import type { TextValueStore } from '@lostgradient/weft/storage';

import { extractKeyId, generateApiKey, hashApiKey, verifyApiKey } from './key-utilities';
import type { ApiKey, ApiKeyStore, CreateApiKeyOptions } from './types';

const KEY_PREFIX = 'api-key:';
const INVALID_SCOPE_ENTRY_MESSAGE = 'API key scope entries must be non-blank strings';

export function normalizeApiKeyScopes(scopes: unknown): string[] {
  if (scopes === undefined) return [];
  if (!Array.isArray(scopes)) {
    throw new Error('API key scopes must be an array of strings');
  }
  const normalizedScopes: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string') {
      throw new Error(INVALID_SCOPE_ENTRY_MESSAGE);
    }
    const normalizedScope = scope.trim();
    if (normalizedScope.length === 0) {
      throw new Error(INVALID_SCOPE_ENTRY_MESSAGE);
    }
    normalizedScopes.push(normalizedScope);
  }
  return Array.from(new Set(normalizedScopes));
}

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
      isValidDate((parsed as Record<string, unknown>)['createdAt']) &&
      Array.isArray((parsed as Record<string, unknown>)['scopes'])
    ) {
      return parsed as ApiKey;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates an API key store backed by a `TextValueStore`. Keys are stored under
 * the `api-key:<id>` prefix. Plaintext keys are never persisted; only their
 * SHA-256 hashes are stored.
 */
export function createApiKeyStore(kv: TextValueStore): ApiKeyStore {
  async function create(options: CreateApiKeyOptions): Promise<{ key: ApiKey; plaintext: string }> {
    const plaintext = generateApiKey();
    const id = extractKeyId(plaintext);
    const scopes = normalizeApiKeyScopes(options.scopes);

    // Guard against ID collision (extremely unlikely with 16 hex chars)
    const existing = await kv.get(`${KEY_PREFIX}${id}`);
    if (existing) {
      throw new Error(`API key ID collision detected for id: ${id}. Retry key creation.`);
    }

    const keyHash = await hashApiKey(plaintext);

    const key: ApiKey = {
      id,
      name: options.name,
      keyHash,
      scopes,
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

    return { ...key, keyHash: '' };
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
