import type { TextValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';

import { createCloudflareR2TextValueStore } from '../src/create-cloudflare-r2-text-value-store';
import type { R2Bucket } from '../src/r2';
import { createFakeR2 } from '../src/test/fake-r2';

describe('createCloudflareR2TextValueStore', () => {
  it('round-trips a value through set/get', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });

    await store.set('skill:code-review:body', 'Do the review.');

    expect(await store.get('skill:code-review:body')).toBe('Do the review.');
  });

  it('returns null for a missing key', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });

    expect(await store.get('missing')).toBeNull();
  });

  it('deletes a key', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });
    await store.set('key', 'value');

    await store.delete('key');

    expect(await store.get('key')).toBeNull();
  });

  it('reports has() for present and absent keys', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });
    await store.set('present', 'value');

    expect(await store.has('present')).toBe(true);
    expect(await store.has('absent')).toBe(false);
  });

  it('has() reads metadata via head(), never the object body via get()', async () => {
    const bucket = createFakeR2();
    const store = createCloudflareR2TextValueStore({ bucket });
    await store.set('present', 'value');

    await store.has('present');
    await store.has('absent');

    expect(bucket.headCalls).toEqual(['present', 'absent']);
    expect(bucket.getCalls).toEqual([]);
  });

  it('list() follows R2 cursor pagination past a single page', async () => {
    // The fake pages at 3 objects per list() call by default, so 7 keys under
    // one prefix forces the adapter's cursor-follow loop to run 3 times.
    const bucket = createFakeR2({ pageSize: 3 });
    const store = createCloudflareR2TextValueStore({ bucket });
    for (let index = 0; index < 7; index += 1) {
      await bucket.put(`skill:big:resource:${String(index).padStart(2, '0')}`, `content-${index}`);
    }
    // A sibling key outside the prefix must not appear in the listing.
    await bucket.put('skill:other:body', 'unrelated');

    const keys = await store.list('skill:big:resource:');

    expect(keys).toHaveLength(7);
    expect(keys.sort()).toEqual(
      Array.from(
        { length: 7 },
        (_, index) => `skill:big:resource:${String(index).padStart(2, '0')}`,
      ),
    );
    expect(bucket.listCalls.length).toBeGreaterThan(1);
  });

  it('deletePrefix() removes every key under the prefix and reports the count', async () => {
    const bucket = createFakeR2({ pageSize: 2 });
    const store = createCloudflareR2TextValueStore({ bucket });
    await store.set('skill:doomed:a', '1');
    await store.set('skill:doomed:b', '2');
    await store.set('skill:doomed:c', '3');
    await store.set('skill:kept:a', 'safe');

    const deleted = await store.deletePrefix('skill:doomed:');

    expect(deleted).toBe(3);
    expect(await store.get('skill:doomed:a')).toBeNull();
    expect(await store.get('skill:doomed:b')).toBeNull();
    expect(await store.get('skill:doomed:c')).toBeNull();
    expect(await store.get('skill:kept:a')).toBe('safe');
  });

  it('fails fast instead of silently truncating when list() reports truncated with no cursor', async () => {
    // A malformed R2-shaped response: truncated: true but no cursor to
    // continue from. Real R2 never does this, but a fake/middleware/proxy
    // might — the adapter must not silently return a partial key set.
    const malformedBucket: R2Bucket = {
      head: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(undefined),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve({ objects: [{ key: 'a' }], truncated: true }),
    };
    const store = createCloudflareR2TextValueStore({ bucket: malformedBucket });

    let caught: unknown;
    try {
      await store.list('prefix');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('truncated: true without a cursor');
  });

  it('close() is a non-owning no-op', async () => {
    const store = createCloudflareR2TextValueStore({ bucket: createFakeR2() });
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('satisfies the TextValueStore shape used by createStorageSkillProvider', () => {
    const store: TextValueStore = createCloudflareR2TextValueStore({ bucket: createFakeR2() });
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.list).toBe('function');
    expect(typeof store.has).toBe('function');
    expect(typeof store.deletePrefix).toBe('function');
    expect(typeof store.close).toBe('function');
  });
});
