import type { KeyValueStore, KeyValueStoreOptions } from '../types';
import { withNamespace } from '../with-namespace';

/** Shape of the chrome.storage area methods used by this adapter. */
interface ChromeStorageArea {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/**
 * Minimal ambient declaration for the `chrome` global.
 *
 * The full `@types/chrome` package pulls in thousands of declarations we
 * don't need. This covers only the `chrome.storage` surface used by this
 * adapter and the availability check.
 */
declare const chrome:
  | {
      storage: Record<string, ChromeStorageArea>;
    }
  | undefined;

/**
 * Checks whether the Chrome Storage API is available in the current environment.
 */
export function isChromeStorageAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage;
}

interface ChromeKeyValueStoreOptions extends KeyValueStoreOptions {
  /** Which Chrome Storage area to use. Defaults to `'local'`. */
  area?: 'local' | 'session';
}

/**
 * Creates a KeyValueStore backed by Chrome's `chrome.storage` API.
 *
 * Works in Chrome extensions and service workers. The `area` option
 * selects between `chrome.storage.local` and `chrome.storage.session`.
 */
export function createChromeKeyValueStore(options?: ChromeKeyValueStoreOptions): KeyValueStore {
  if (!chrome?.storage) {
    throw new Error('Chrome Storage API is not available in this environment');
  }

  const area = options?.area ?? 'local';
  const storage = chrome.storage[area]!;

  const store: KeyValueStore = {
    async get(key: string): Promise<string | null> {
      const result = await storage.get(key);
      if (key in result) {
        return result[key] as string;
      }
      return null;
    },

    async set(key: string, value: string): Promise<void> {
      await storage.set({ [key]: value });
    },

    async delete(key: string): Promise<void> {
      await storage.remove(key);
    },

    async list(prefix: string): Promise<string[]> {
      const all = await storage.get(null);
      return Object.keys(all)
        .filter((key) => key.startsWith(prefix))
        .sort();
    },

    async has(key: string): Promise<boolean> {
      const result = await storage.get(key);
      return key in result;
    },

    async deletePrefix(prefix: string): Promise<number> {
      const all = await storage.get(null);
      const matching = Object.keys(all).filter((key) => key.startsWith(prefix));
      if (matching.length > 0) {
        await storage.remove(matching);
      }
      return matching.length;
    },

    close(): Promise<void> {
      return Promise.resolve();
    },
  };

  if (options?.namespace) {
    return withNamespace(store, options.namespace);
  }

  return store;
}
