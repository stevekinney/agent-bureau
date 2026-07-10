import type { TextValueStore } from '@lostgradient/weft/storage';

import type { R2Bucket } from './r2';

/**
 * Options for {@link createCloudflareR2TextValueStore}.
 */
export interface CreateCloudflareR2TextValueStoreOptions {
  /**
   * The injectable R2 surface. In production this is an R2 bucket binding
   * from the Worker's env; in tests it is a recording fake.
   */
  bucket: R2Bucket;
}

/**
 * Creates a Weft {@link TextValueStore} backed by a Cloudflare R2 bucket.
 *
 * R2 is the right Workers-native fit for large, unstructured text content —
 * bundled skill bodies/resources (`skills`'s `createStorageSkillProvider`
 * consumes exactly this `TextValueStore` shape) and large tool outputs that
 * would blow past a KV/D1/DO-SQLite row-size budget. It is intentionally a
 * plain `TextValueStore`, not a `ConditionalTextValueStore`: R2 has no native
 * multi-key compare-and-swap, and neither named consumer (skills, tool
 * output archival) needs one — `createStorageSkillProvider` only ever calls
 * `get`/`set`/`delete`/`list`. Callers that need session-store-grade
 * compare-and-swap should use {@link createCloudflareSqliteStorage} instead.
 *
 * `list(prefix)` follows R2's `cursor` pagination until `truncated` is
 * `false`, so it always returns the full matching key set in one call.
 */
export function createCloudflareR2TextValueStore(
  options: CreateCloudflareR2TextValueStoreOptions,
): TextValueStore {
  const { bucket } = options;

  /** Follow R2's `cursor` pagination to collect every key under `prefix`. */
  async function listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    let truncated = true;
    while (truncated) {
      const result: Awaited<ReturnType<R2Bucket['list']>> = await bucket.list({
        prefix,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const object of result.objects) keys.push(object.key);
      truncated = result.truncated;
      if (truncated && result.cursor === undefined) {
        // A `truncated: true` result with no `cursor` is a malformed R2
        // response (real R2 always pairs `truncated: true` with a `cursor`).
        // Fail fast instead of silently returning a partial key set.
        throw new Error(
          `R2 list() reported truncated: true without a cursor for prefix "${prefix}".`,
        );
      }
      cursor = result.cursor;
    }
    return keys;
  }

  return {
    async get(key: string): Promise<string | null> {
      const object = await bucket.get(key);
      return object === null ? null : object.text();
    },

    async set(key: string, value: string): Promise<void> {
      await bucket.put(key, value);
    },

    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },

    list(prefix: string): Promise<string[]> {
      return listKeys(prefix);
    },

    async has(key: string): Promise<boolean> {
      // `head` reads metadata only — cheaper than `get` for an existence
      // check, and avoids pulling a large tool-output body into memory just
      // to test presence.
      const object = await bucket.head(key);
      return object !== null;
    },

    async deletePrefix(prefix: string): Promise<number> {
      const keys = await listKeys(prefix);
      for (const key of keys) await bucket.delete(key);
      return keys.length;
    },

    close(): Promise<void> {
      // No-op: the `bucket` binding is injected and shared with the rest of
      // the Worker; this adapter is a non-owning view and must not dispose it.
      return Promise.resolve();
    },
  };
}
