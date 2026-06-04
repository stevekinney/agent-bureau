import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { createApiKeyStore } from '../keys/create-api-key-store';
import type { ApiKeyStore } from '../keys/types';
import { errorHandler } from '../middleware/error-handler';
import { requestIdentifier } from '../middleware/request-identifier';
import { createKeysRoutes } from './keys';

function createApp(apiKeyStore?: ApiKeyStore) {
  const kv = textValueStore(new MemoryStorage());
  const store = apiKeyStore ?? createApiKeyStore(kv);
  const app = new Hono();
  app.use('*', requestIdentifier);
  app.route('/api/v1/keys', createKeysRoutes(store));
  app.onError(errorHandler);
  return { app, store };
}

describe('key management routes', () => {
  describe('POST /api/v1/keys', () => {
    it('creates a key and returns plaintext', async () => {
      const { app } = createApp();
      const response = await app.request('/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'my-key' }),
      });
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.plaintext).toStartWith('ab_live_');
      expect(body.key.name).toBe('my-key');
      expect(body.key.active).toBe(true);
    });

    it('accepts optional scopes and expiresAt', async () => {
      const { app } = createApp();
      const expires = new Date(Date.now() + 86400000).toISOString();
      const response = await app.request('/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'scoped-key',
          scopes: ['runs:read'],
          expiresAt: expires,
        }),
      });
      expect(response.status).toBe(201);

      const body = await response.json();
      expect(body.key.scopes).toEqual(['runs:read']);
      expect(body.key.expiresAt).toBe(expires);
    });

    it('rejects missing name', async () => {
      const { app } = createApp();
      const response = await app.request('/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it('rejects invalid body', async () => {
      const { app } = createApp();
      const response = await app.request('/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      });
      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/keys', () => {
    it('returns all keys without hashes', async () => {
      const { app, store } = createApp();
      await store.create({ name: 'key-a' });
      await store.create({ name: 'key-b' });

      const response = await app.request('/api/v1/keys');
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveLength(2);
      for (const key of body) {
        expect(key.keyHash).toBe('');
      }
    });

    it('returns empty array when no keys exist', async () => {
      const { app } = createApp();
      const response = await app.request('/api/v1/keys');
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual([]);
    });
  });

  describe('DELETE /api/v1/keys/:id', () => {
    it('revokes a key', async () => {
      const { app, store } = createApp();
      const { key } = await store.create({ name: 'to-revoke' });

      const response = await app.request(`/api/v1/keys/${key.id}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(204);

      const keys = await store.list();
      const revoked = keys.find((k) => k.id === key.id);
      expect(revoked!.active).toBe(false);
    });
  });

  describe('POST /api/v1/keys/:id/rotate', () => {
    it('rotates a key', async () => {
      const { app, store } = createApp();
      const { key: original, plaintext: originalPlaintext } = await store.create({
        name: 'rotate-me',
        scopes: ['runs:read'],
      });

      const response = await app.request(`/api/v1/keys/${original.id}/rotate`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.key.name).toBe('rotate-me');
      expect(body.key.scopes).toEqual(['runs:read']);
      expect(body.plaintext).toStartWith('ab_live_');
      expect(body.plaintext).not.toBe(originalPlaintext);

      // Old key should be revoked
      const oldVerify = await store.verify(originalPlaintext);
      expect(oldVerify).toBeNull();
    });

    it('returns 404 for non-existent key', async () => {
      const { app } = createApp();
      const response = await app.request('/api/v1/keys/nonexistent/rotate', {
        method: 'POST',
      });
      expect(response.status).toBe(404);
    });
  });
});
