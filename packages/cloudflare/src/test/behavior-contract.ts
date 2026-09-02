import type { TextValueStore } from '@lostgradient/weft/storage';
import type { Storage } from '@lostgradient/weft/storage/interface';
import { describe, expect, it } from 'bun:test';
import type { MemoryRecord, MemoryRecordScope, MemoryRecordStorage } from 'memory';

/** The name of a Cloudflare backend capability {@link runCloudflareBackendContract} gates on. */
export type CloudflareCapabilityName = 'vectorize';

/**
 * A single backend capability, typed so an unsupported outcome is a checkable
 * value rather than a skipped test. Per the AB-276 coordinator ruling, the
 * real-runtime lane declares `vectorize` unsupported with `owningIssue:
 * 'AB-276'` and `reason: 'vectorize-remote-only'`; the fast double always
 * declares it supported.
 */
export type CloudflareCapability =
  | { readonly name: CloudflareCapabilityName; readonly outcome: 'supported' }
  | {
      readonly name: CloudflareCapabilityName;
      readonly outcome: 'unsupported';
      readonly owningIssue: string;
      readonly reason: string;
    };

/**
 * The adapter-output bindings {@link runCloudflareBackendContract} exercises.
 * These are the OUTPUTS of `createCloudflareSqliteStorage`,
 * `createCloudflareR2TextValueStore`, and (when vectorize is supported)
 * `createCloudflareMemoryRecordStorage` — not their raw `Sql`/`R2Bucket`/
 * `VectorizeIndex` inputs. Durable Object `SqlStorage.exec` is synchronous and
 * only reachable from inside the Durable Object, so the real lane cannot hand
 * back a raw `Sql` binding the way the fast double can; adapter-output level
 * is the one shape both lanes can produce.
 */
export interface CloudflareContractBindings {
  /** A fresh `Storage` from `createCloudflareSqliteStorage`. */
  readonly sqliteStorage: Storage;
  /** A fresh `TextValueStore` from `createCloudflareR2TextValueStore`. */
  readonly r2Store: TextValueStore;
  /**
   * A fresh `MemoryRecordStorage` from `createCloudflareMemoryRecordStorage`,
   * or `undefined` when the `vectorize` capability is unsupported for this
   * run — `runCloudflareBackendContract` asserts the typed-unsupported
   * outcome instead of exercising it.
   */
  readonly memoryRecordStorage: MemoryRecordStorage | undefined;
}

/** Options for {@link runCloudflareBackendContract}. */
export interface RunCloudflareBackendContractOptions {
  /** Identifies this run in `describe()` names (e.g. `'fast double'`, `'real runtime'`). */
  readonly label: string;
  /** Builds a fresh set of bindings for each contract case. */
  createBindings(): Promise<CloudflareContractBindings>;
  /** This run's capability declarations. */
  readonly capabilities: readonly CloudflareCapability[];
}

function findCapability(
  capabilities: readonly CloudflareCapability[],
  name: CloudflareCapabilityName,
): CloudflareCapability | undefined {
  return capabilities.find((capability) => capability.name === name);
}

/**
 * Reads `memoryRecordStorage` off a fresh set of bindings, asserting it is
 * present via a cast rather than a runtime `if`/`throw`. The describe block
 * calling this only ever runs it when `vectorizeCapability?.outcome ===
 * 'supported'`, and `RunCloudflareBackendContractOptions` documents that a
 * caller only omits `memoryRecordStorage` when its `vectorize` capability is
 * `'unsupported'` — the cast makes that documented caller invariant explicit
 * instead of adding a defensive branch neither lane's tests can ever exercise.
 */
async function requireMemoryRecordStorage(
  createBindings: () => Promise<CloudflareContractBindings>,
): Promise<MemoryRecordStorage> {
  const { memoryRecordStorage } = await createBindings();
  return memoryRecordStorage as MemoryRecordStorage;
}

function memoryScope(): MemoryRecordScope {
  return { tenantId: 'contract-tenant', namespace: 'contract-namespace' };
}

function memoryRecordInput(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: overrides.id ?? 'contract-record',
    tenantId: 'contract-tenant',
    namespace: 'contract-namespace',
    content: overrides.content ?? 'contract content',
    vector: overrides.vector ?? new Float32Array([1, 0, 0]),
    metadata: overrides.metadata ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    version: overrides.version ?? 1,
    status: overrides.status ?? 'active',
  };
}

/**
 * Runs one shared behavior contract — initialization, schema creation, store
 * and query behavior, serialization boundaries, and tombstones — against
 * whatever bindings `options.createBindings()` produces. Called once against
 * the fast Bun doubles and once against the real Miniflare/workerd runtime
 * lane so "the same contract runs against the double and the real runtime" is
 * structurally true rather than a claim made in prose.
 *
 * Adversarial and cross-store-poisoning scenarios (a Vectorize match with a
 * spoofed tenant, a corrupted SQLite row, a torn tombstone/index write) are
 * deliberately NOT here: they require an adversarial double that can inject
 * specific wire-level malformations, which has no real-runtime equivalent —
 * see `test/rehydration-security.test.ts`, `test/decode-and-scope-validation.test.ts`,
 * and `test/tombstone-ordering.test.ts`'s instrumented-double cases, which stay
 * double-only for that reason and are not migrated here.
 */
export function runCloudflareBackendContract(options: RunCloudflareBackendContractOptions): void {
  const { label, createBindings, capabilities } = options;

  describe(`Cloudflare backend contract (${label})`, () => {
    describe('Durable Object SQLite storage', () => {
      it('initializes lazily and creates its schema on first use', async () => {
        const { sqliteStorage } = await createBindings();

        expect(await sqliteStorage.get('unwritten-key')).toBeNull();
        await sqliteStorage.put('schema-probe', new Uint8Array([9]));
        expect(await sqliteStorage.get('schema-probe')).toEqual(new Uint8Array([9]));
      });

      it('round-trips a put/get/delete cycle', async () => {
        const { sqliteStorage } = await createBindings();

        await sqliteStorage.put('kv:one', new Uint8Array([1, 2, 3]));
        expect(await sqliteStorage.get('kv:one')).toEqual(new Uint8Array([1, 2, 3]));

        await sqliteStorage.delete('kv:one');
        expect(await sqliteStorage.get('kv:one')).toBeNull();
      });

      it('scans a key range in lexicographic order', async () => {
        const { sqliteStorage } = await createBindings();

        await sqliteStorage.put('scan:b', new Uint8Array([2]));
        await sqliteStorage.put('scan:a', new Uint8Array([1]));
        await sqliteStorage.put('scan:c', new Uint8Array([3]));

        const keys: string[] = [];
        for await (const [key] of sqliteStorage.scan('scan:')) keys.push(key);

        expect(keys).toEqual(['scan:a', 'scan:b', 'scan:c']);
      });

      it('reports declared storage capabilities', async () => {
        const { sqliteStorage } = await createBindings();

        expect(sqliteStorage.capabilities()).toEqual({
          persistence: 'local',
          readAfterWrite: 'linearizable',
          scanConsistency: 'snapshot',
          atomicBatch: true,
          conditionalBatch: true,
          boundedRangeDelete: true,
        });
      });

      it('applies a batch, reports has/count, and bounded-deletes a prefix', async () => {
        const { sqliteStorage } = await createBindings();

        await sqliteStorage.batch([
          { type: 'put', key: 'batch:one', value: new Uint8Array([1]) },
          { type: 'put', key: 'batch:two', value: new Uint8Array([2]) },
        ]);

        expect(await sqliteStorage.has?.('batch:one')).toBe(true);
        expect(await sqliteStorage.has?.('batch:missing')).toBe(false);
        expect(await sqliteStorage.count?.('batch:')).toBe(2);

        const keys: string[] = [];
        for await (const key of sqliteStorage.keys?.('batch:') ?? []) keys.push(key);
        expect(keys.toSorted()).toEqual(['batch:one', 'batch:two']);

        expect(await sqliteStorage.deletePrefix?.('batch:')).toBe(2);
        expect(await sqliteStorage.count?.('batch:')).toBe(0);

        await sqliteStorage.put('batch:three', new Uint8Array([3]));
        await sqliteStorage.batch([{ type: 'delete', key: 'batch:three' }]);
        expect(await sqliteStorage.get('batch:three')).toBeNull();
      });

      it('disposes as a non-owning no-op, leaving the storage usable afterward', async () => {
        const { sqliteStorage } = await createBindings();

        sqliteStorage[Symbol.dispose]();

        // The disposed handle is a non-owning view over shared state; a fresh
        // operation through it still works (nothing underlying was torn down).
        await sqliteStorage.put('post-dispose-key', new Uint8Array([1]));
        expect(await sqliteStorage.get('post-dispose-key')).toEqual(new Uint8Array([1]));
      });

      it('applies a conditionalBatch only when every precondition matches', async () => {
        const { sqliteStorage } = await createBindings();
        await sqliteStorage.put('conditional:key', new Uint8Array([1]));

        const rejected = await sqliteStorage.conditionalBatch?.(
          [{ key: 'conditional:key', expectedValue: new Uint8Array([9]) }],
          [{ type: 'put', key: 'conditional:key', value: new Uint8Array([2]) }],
        );
        expect(rejected).toBe(false);
        expect(await sqliteStorage.get('conditional:key')).toEqual(new Uint8Array([1]));

        const applied = await sqliteStorage.conditionalBatch?.(
          [{ key: 'conditional:key', expectedValue: new Uint8Array([1]) }],
          [{ type: 'put', key: 'conditional:key', value: new Uint8Array([2]) }],
        );
        expect(applied).toBe(true);
        expect(await sqliteStorage.get('conditional:key')).toEqual(new Uint8Array([2]));

        const deleteApplied = await sqliteStorage.conditionalBatch?.(
          [{ key: 'conditional:key', expectedValue: new Uint8Array([2]) }],
          [{ type: 'delete', key: 'conditional:key' }],
        );
        expect(deleteApplied).toBe(true);
        expect(await sqliteStorage.get('conditional:key')).toBeNull();
      });
    });

    describe('R2 text value store', () => {
      it('round-trips a set/get/delete cycle', async () => {
        const { r2Store } = await createBindings();

        await r2Store.set('r2:contract-key', 'contract value');
        expect(await r2Store.get('r2:contract-key')).toBe('contract value');

        await r2Store.delete('r2:contract-key');
        expect(await r2Store.get('r2:contract-key')).toBeNull();
      });

      it('reports has() for present and absent keys', async () => {
        const { r2Store } = await createBindings();
        await r2Store.set('r2:has-present', 'value');

        expect(await r2Store.has('r2:has-present')).toBe(true);
        expect(await r2Store.has('r2:has-absent')).toBe(false);
      });

      it('lists keys under a prefix', async () => {
        const { r2Store } = await createBindings();

        await r2Store.set('r2-list:one', 'a');
        await r2Store.set('r2-list:two', 'b');
        await r2Store.set('sibling:three', 'c');

        const listedKeys = await r2Store.list('r2-list:');
        const keys = listedKeys.toSorted();

        expect(keys).toEqual(['r2-list:one', 'r2-list:two']);
      });

      it('serializes text content through the store boundary unchanged', async () => {
        const { r2Store } = await createBindings();
        const value = JSON.stringify({ nested: ['unicode: 🎈', 'newline:\n'] });

        await r2Store.set('r2:serialization', value);

        expect(await r2Store.get('r2:serialization')).toBe(value);
      });
    });

    const vectorizeCapability = findCapability(capabilities, 'vectorize');

    describe('Memory record storage (Vectorize-backed)', () => {
      if (vectorizeCapability?.outcome !== 'supported') {
        it('declares vectorize a typed unsupported capability rather than being skipped', () => {
          expect(vectorizeCapability).toEqual({
            name: 'vectorize',
            outcome: 'unsupported',
            owningIssue: 'AB-276',
            reason: 'vectorize-remote-only',
          });
        });
        return;
      }

      it('initializes and stores/queries a record round trip', async () => {
        const memoryRecordStorage = await requireMemoryRecordStorage(createBindings);
        await memoryRecordStorage.init();

        const record = memoryRecordInput();
        await memoryRecordStorage.put(record);

        const fetched = await memoryRecordStorage.get(record.id, memoryScope());
        expect(fetched?.content).toBe(record.content);

        const hits = await memoryRecordStorage.searchByVector(record.vector, memoryScope(), {
          limit: 5,
        });
        expect(hits.map((hit) => hit.id)).toContain(record.id);

        await memoryRecordStorage.close();
      });

      it('round-trips JSON-serialized vector and metadata through the storage boundary', async () => {
        const memoryRecordStorage = await requireMemoryRecordStorage(createBindings);
        await memoryRecordStorage.init();

        const record = memoryRecordInput({
          id: 'serialization-record',
          vector: new Float32Array([0.5, -0.25, 0.75]),
          metadata: { nested: { unicode: '🎈' }, list: [1, 2, 3] },
        });
        await memoryRecordStorage.put(record);

        const fetched = await memoryRecordStorage.get(record.id, memoryScope());
        expect(Array.from(fetched?.vector ?? [])).toEqual([0.5, -0.25, 0.75]);
        expect(fetched?.metadata).toEqual({ nested: { unicode: '🎈' }, list: [1, 2, 3] });

        await memoryRecordStorage.close();
      });

      it('tombstones a deleted record so it disappears from every read', async () => {
        const memoryRecordStorage = await requireMemoryRecordStorage(createBindings);
        await memoryRecordStorage.init();

        const record = memoryRecordInput({ id: 'tombstone-record' });
        // A surviving record in the same direction as `record.vector` keeps
        // `hits` non-empty after the delete below, so the assertion below
        // exercises its `.map()` callback rather than mapping over `[]`.
        const survivor = memoryRecordInput({ id: 'tombstone-survivor' });
        await memoryRecordStorage.put(record);
        await memoryRecordStorage.put(survivor);
        expect(await memoryRecordStorage.get(record.id, memoryScope())).toBeDefined();

        const deleted = await memoryRecordStorage.delete(record.id, memoryScope());
        expect(deleted).toBe(true);

        expect(await memoryRecordStorage.get(record.id, memoryScope())).toBeUndefined();
        const hits = await memoryRecordStorage.searchByVector(record.vector, memoryScope(), {
          limit: 5,
        });
        expect(hits.map((hit) => hit.id)).toEqual([survivor.id]);

        await memoryRecordStorage.close();
      });
    });
  });
}
