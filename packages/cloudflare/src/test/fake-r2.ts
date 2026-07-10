import type { R2Bucket, R2ListOptions, R2ListResult, R2ObjectBody } from '../r2';

/**
 * A recording, in-memory {@link R2Bucket} fake for tests.
 *
 * Cloudflare's R2 binding does not exist under `bun:test`, so the R2-backed
 * text-value store takes an injectable {@link R2Bucket}. This fake satisfies
 * that interface with a `Map<string, string>`, records every call, and
 * paginates `list()` in fixed-size pages (default 3) even though the whole
 * bucket fits in memory — so tests exercise the adapter's real cursor-follow
 * loop instead of assuming a single-page result.
 */
export interface FakeR2 extends R2Bucket {
  /** Every key passed to `get`, in order. */
  readonly getCalls: string[];
  /** Every `[key, value]` pair passed to `put`, in order. */
  readonly putCalls: ReadonlyArray<readonly [string, string]>;
  /** Every key passed to `delete`, in order. */
  readonly deleteCalls: string[];
  /** Every options object passed to `list`, in order. */
  readonly listCalls: R2ListOptions[];
}

/** Creates a recording, in-memory {@link FakeR2}. */
export function createFakeR2(options?: { pageSize?: number }): FakeR2 {
  const objects = new Map<string, string>();
  const getCalls: string[] = [];
  const putCalls: Array<readonly [string, string]> = [];
  const deleteCalls: string[] = [];
  const listCalls: R2ListOptions[] = [];
  const pageSize = options?.pageSize ?? 3;

  return {
    getCalls,
    putCalls,
    deleteCalls,
    listCalls,

    get(key: string): Promise<R2ObjectBody | null> {
      getCalls.push(key);
      const value = objects.get(key);
      if (value === undefined) return Promise.resolve(null);
      return Promise.resolve({ text: () => Promise.resolve(value) });
    },

    put(key: string, value: string): Promise<void> {
      putCalls.push([key, value]);
      objects.set(key, value);
      return Promise.resolve();
    },

    delete(key: string): Promise<void> {
      deleteCalls.push(key);
      objects.delete(key);
      return Promise.resolve();
    },

    list(listOptions: R2ListOptions = {}): Promise<R2ListResult> {
      listCalls.push({ ...listOptions });
      const prefix = listOptions.prefix ?? '';
      const matching = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();

      const cursorIndex =
        listOptions.cursor === undefined ? 0 : Number.parseInt(listOptions.cursor, 10);
      const limit = Math.min(listOptions.limit ?? pageSize, pageSize);
      const page = matching.slice(cursorIndex, cursorIndex + limit);
      const nextIndex = cursorIndex + page.length;
      const truncated = nextIndex < matching.length;

      return Promise.resolve({
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(nextIndex) } : {}),
      });
    },
  };
}
