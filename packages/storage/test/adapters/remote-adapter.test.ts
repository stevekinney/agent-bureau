import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { createRemoteKeyValueStore, RemoteStoreError } from '../../src/adapters/remote-adapter';
import type { KeyValueStore } from '../../src/types';

describe('createRemoteKeyValueStore', () => {
  const baseUrl = 'https://api.example.com';
  let store: KeyValueStore;
  const mockFetch = mock<typeof globalThis.fetch>();

  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch;
    store = createRemoteKeyValueStore({ baseUrl });
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe('get', () => {
    it('sends GET request with encoded key', async () => {
      mockFetch.mockResolvedValueOnce(new Response('value', { status: 200 }));

      const result = await store.get('my:key');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv/${encodeURIComponent('my:key')}`);
      expect((options as RequestInit).method).toBe('GET');
      expect(result).toBe('value');
    });

    it('returns null on 404', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));

      expect(await store.get('missing')).toBeNull();
    });

    it('throws RemoteStoreError on non-200/404 status', async () => {
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));

      try {
        await store.get('key');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteStoreError);
        expect((error as RemoteStoreError).status).toBe(500);
        expect((error as RemoteStoreError).message).toBe('server error');
      }
    });

    it('URL-encodes keys with special characters', async () => {
      mockFetch.mockResolvedValueOnce(new Response('value', { status: 200 }));

      await store.get('path/with spaces&symbols=yes');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv/${encodeURIComponent('path/with spaces&symbols=yes')}`);
    });
  });

  describe('set', () => {
    it('sends PUT request with body', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await store.set('key', 'value');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv/${encodeURIComponent('key')}`);
      expect((options as RequestInit).method).toBe('PUT');
      expect((options as RequestInit).body).toBe('value');
    });

    it('throws RemoteStoreError on failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

      try {
        await store.set('key', 'value');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteStoreError);
        expect((error as RemoteStoreError).status).toBe(403);
      }
    });
  });

  describe('delete', () => {
    it('sends DELETE request', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      await store.delete('key');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv/${encodeURIComponent('key')}`);
      expect((options as RequestInit).method).toBe('DELETE');
    });

    it('throws RemoteStoreError on failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));

      try {
        await store.delete('key');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteStoreError);
        expect((error as RemoteStoreError).status).toBe(500);
      }
    });
  });

  describe('list', () => {
    it('sends GET request with prefix query parameter', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(['skill:a', 'skill:b']), { status: 200 }),
      );

      const keys = await store.list('skill:');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv?prefix=${encodeURIComponent('skill:')}`);
      expect((options as RequestInit).method).toBe('GET');
      expect(keys).toEqual(['skill:a', 'skill:b']);
    });

    it('throws RemoteStoreError on failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));

      try {
        await store.list('prefix:');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteStoreError);
      }
    });
  });

  describe('has', () => {
    it('sends HEAD request and returns true on 200', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      expect(await store.has!('key')).toBe(true);

      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv/${encodeURIComponent('key')}`);
      expect((options as RequestInit).method).toBe('HEAD');
    });

    it('returns false on 404', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

      expect(await store.has!('missing')).toBe(false);
    });

    it('throws RemoteStoreError on other statuses', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 503 }));

      try {
        await store.has!('key');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteStoreError);
        expect((error as RemoteStoreError).status).toBe(503);
      }
    });
  });

  describe('deletePrefix', () => {
    it('sends DELETE request with prefix query parameter and returns count', async () => {
      mockFetch.mockResolvedValueOnce(new Response('3', { status: 200 }));

      const count = await store.deletePrefix!('skill:');

      expect(count).toBe(3);
      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv?prefix=${encodeURIComponent('skill:')}`);
      expect((options as RequestInit).method).toBe('DELETE');
    });

    it('throws RemoteStoreError on failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 500 }));

      try {
        await store.deletePrefix!('prefix:');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteStoreError);
      }
    });
  });

  describe('close', () => {
    it('close is a no-op', async () => {
      await expect(store.close!()).resolves.toBeUndefined();
    });
  });

  describe('custom headers', () => {
    it('includes custom headers in every request', async () => {
      const storeWithHeaders = createRemoteKeyValueStore({
        baseUrl,
        headers: {
          Authorization: 'Bearer token123',
          'X-Custom': 'custom-value',
        },
      });

      mockFetch.mockResolvedValueOnce(new Response('value', { status: 200 }));

      await storeWithHeaders.get('key');

      const [, options] = mockFetch.mock.calls[0]!;
      const headers = (options as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer token123');
      expect(headers['X-Custom']).toBe('custom-value');
    });
  });

  describe('namespace support', () => {
    it('wraps store with namespace prefix', async () => {
      const namespacedStore = createRemoteKeyValueStore({
        baseUrl,
        namespace: 'test-ns',
      });

      mockFetch.mockResolvedValueOnce(new Response('value', { status: 200 }));

      await namespacedStore.get('key');

      // The namespace wrapper prefixes the key before passing to the store
      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${baseUrl}/kv/${encodeURIComponent('test-ns:key')}`);
    });
  });
});

describe('RemoteStoreError', () => {
  it('has status and message', () => {
    const error = new RemoteStoreError(500, 'Internal Server Error');
    expect(error.status).toBe(500);
    expect(error.message).toBe('Internal Server Error');
    expect(error.name).toBe('RemoteStoreError');
    expect(error).toBeInstanceOf(Error);
  });
});
