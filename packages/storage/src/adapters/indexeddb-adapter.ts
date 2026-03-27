import type { KeyValueStore, KeyValueStoreOptions } from '../types';
import { withNamespace } from '../with-namespace';

/**
 * Checks whether the IndexedDB API is available in the current environment.
 */
export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

interface IndexedDBKeyValueStoreOptions extends KeyValueStoreOptions {
  /** Name of the IndexedDB database. Defaults to `'agent-bureau'`. */
  databaseName?: string;
  /** Name of the object store within the database. Defaults to `'kv'`. */
  storeName?: string;
}

/** Wraps an IDBRequest error into a proper Error for promise rejection. */
function requestError(request: IDBRequest): Error {
  return request.error ?? new Error('Unknown IndexedDB error');
}

/**
 * Opens (or creates) an IndexedDB database with the specified object store.
 */
function openDatabase(databaseName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(requestError(request));
  });
}

/**
 * Creates a KeyValueStore backed by IndexedDB.
 *
 * Suitable for browser environments where persistent, structured storage
 * is needed. Each operation runs in its own transaction for simplicity.
 */
export async function createIndexedDBKeyValueStore(
  options?: IndexedDBKeyValueStoreOptions,
): Promise<KeyValueStore> {
  const databaseName = options?.databaseName ?? 'agent-bureau';
  const storeName = options?.storeName ?? 'kv';

  const database = await openDatabase(databaseName, storeName);

  const store: KeyValueStore = {
    get(key: string): Promise<string | null> {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.get(key);

        request.onsuccess = () => {
          const result: unknown = request.result;
          resolve(result !== undefined ? (result as string) : null);
        };
        request.onerror = () => reject(requestError(request));
      });
    },

    set(key: string, value: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.put(value, key);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(requestError(request));
      });
    },

    delete(key: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.delete(key);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(requestError(request));
      });
    },

    list(prefix: string): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const objectStore = transaction.objectStore(storeName);
        const keys: string[] = [];

        if (prefix === '') {
          const request = objectStore.getAllKeys();
          request.onsuccess = () => {
            for (const key of request.result) {
              keys.push(key as string);
            }
            resolve(keys.sort());
          };
          request.onerror = () => reject(requestError(request));
        } else {
          const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
          const request = objectStore.openCursor(range);
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
              keys.push(cursor.key as string);
              cursor.continue();
            } else {
              resolve(keys.sort());
            }
          };
          request.onerror = () => reject(requestError(request));
        }
      });
    },

    has(key: string): Promise<boolean> {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const objectStore = transaction.objectStore(storeName);
        const request = objectStore.getKey(key);

        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(requestError(request));
      });
    },

    deletePrefix(prefix: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readwrite');
        const objectStore = transaction.objectStore(storeName);
        const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
        const request = objectStore.openCursor(range);
        let count = 0;

        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            count++;
            cursor.continue();
          } else {
            resolve(count);
          }
        };
        request.onerror = () => reject(requestError(request));
      });
    },

    close(): Promise<void> {
      database.close();
      return Promise.resolve();
    },
  };

  if (options?.namespace) {
    return withNamespace(store, options.namespace);
  }

  return store;
}
