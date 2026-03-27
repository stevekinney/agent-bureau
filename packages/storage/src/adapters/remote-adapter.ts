import type { KeyValueStore, KeyValueStoreOptions } from '../types';
import { withNamespace } from '../with-namespace';

/**
 * Error thrown when the remote key-value store returns a non-success response.
 */
export class RemoteStoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteStoreError';
  }
}

interface RemoteKeyValueStoreOptions extends KeyValueStoreOptions {
  /** Base URL of the remote key-value service (no trailing slash). */
  baseUrl: string;
  /** Optional headers included in every HTTP request. */
  headers?: Record<string, string>;
}

/**
 * Throws a `RemoteStoreError` if the response status is not in the
 * set of acceptable statuses.
 */
async function assertAcceptableStatus(response: Response, ...acceptable: number[]): Promise<void> {
  if (!acceptable.includes(response.status)) {
    const body = await response.text();
    throw new RemoteStoreError(response.status, body);
  }
}

/**
 * Creates a KeyValueStore backed by a remote HTTP service.
 *
 * Operations are mapped to standard HTTP methods:
 * - `get`          -> `GET    /kv/{key}`
 * - `set`          -> `PUT    /kv/{key}`
 * - `delete`       -> `DELETE /kv/{key}`
 * - `list`         -> `GET    /kv?prefix={prefix}`
 * - `has`          -> `HEAD   /kv/{key}`
 * - `deletePrefix` -> `DELETE /kv?prefix={prefix}`
 */
export function createRemoteKeyValueStore(options: RemoteKeyValueStoreOptions): KeyValueStore {
  const { baseUrl, headers = {} } = options;

  function keyUrl(key: string): string {
    return `${baseUrl}/kv/${encodeURIComponent(key)}`;
  }

  function prefixUrl(prefix: string): string {
    return `${baseUrl}/kv?prefix=${encodeURIComponent(prefix)}`;
  }

  const store: KeyValueStore = {
    async get(key: string): Promise<string | null> {
      const response = await fetch(keyUrl(key), {
        method: 'GET',
        headers,
      });

      if (response.status === 404) return null;
      await assertAcceptableStatus(response, 200);
      return response.text();
    },

    async set(key: string, value: string): Promise<void> {
      const response = await fetch(keyUrl(key), {
        method: 'PUT',
        headers,
        body: value,
      });

      await assertAcceptableStatus(response, 200);
    },

    async delete(key: string): Promise<void> {
      const response = await fetch(keyUrl(key), {
        method: 'DELETE',
        headers,
      });

      await assertAcceptableStatus(response, 200);
    },

    async list(prefix: string): Promise<string[]> {
      const response = await fetch(prefixUrl(prefix), {
        method: 'GET',
        headers,
      });

      await assertAcceptableStatus(response, 200);
      const body: unknown = await response.json();
      if (!Array.isArray(body) || !body.every((item): item is string => typeof item === 'string')) {
        throw new RemoteStoreError(200, 'Expected string array from list endpoint');
      }
      return body;
    },

    async has(key: string): Promise<boolean> {
      const response = await fetch(keyUrl(key), {
        method: 'HEAD',
        headers,
      });

      if (response.status === 404) return false;
      if (response.status === 200) return true;
      await assertAcceptableStatus(response, 200, 404);
      return false;
    },

    async deletePrefix(prefix: string): Promise<number> {
      const response = await fetch(prefixUrl(prefix), {
        method: 'DELETE',
        headers,
      });

      await assertAcceptableStatus(response, 200);
      const text = await response.text();
      const count = Number(text);
      if (!Number.isFinite(count)) {
        throw new RemoteStoreError(200, 'Expected numeric count from deletePrefix endpoint');
      }
      return count;
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };

  if (options.namespace) {
    return withNamespace(store, options.namespace);
  }

  return store;
}
