import type { TextValueStore } from '@lostgradient/weft/storage';
import { describe, expect, it } from 'bun:test';

import { createCloudflareR2TextValueStore } from '../src/create-cloudflare-r2-text-value-store';
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
