/**
 * The durable half of COR-772's parent-child topology: child records,
 * delegation grants, and the reserve/release budget ledger, persisted over
 * Bureau's conditional key-value store with compare-and-swap writes.
 */
import {
  DELEGATION_GRANT_VERSION,
  type DelegationGrant,
  signDelegationGrant,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  type BureauChildRecord,
  CHILD_RECORD_KEY_PREFIX,
  createChildTopologyStore,
  DELEGATION_GRANT_KEY_PREFIX,
  DELEGATION_LEDGER_KEY_PREFIX,
  type DelegationLedgerEntry,
} from './child-topology-store';
import { throwingRejectionOf } from './testing/promise-outcome.test-support.ts';

function createKv() {
  return textValueStore(new MemoryStorage());
}

function childRecord(overrides: Partial<BureauChildRecord> = {}): BureauChildRecord {
  return {
    schemaVersion: 1,
    parentRunId: 'parent-1',
    childRunId: 'child-1',
    parentAgentName: 'planner',
    childAgentName: 'worker',
    status: 'running',
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
    recoveries: 0,
    workflow: { kind: 'durable', workflowType: 'agentRun', workflowId: 'child-1' },
    parentCancellation: 'cascade',
    ...overrides,
  };
}

function grant(overrides: Partial<DelegationGrant> = {}): DelegationGrant {
  return signDelegationGrant(
    {
      version: DELEGATION_GRANT_VERSION,
      id: 'delegation:1',
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      agentName: 'worker',
      agentVersion: '1',
      objective: 'work',
      recipientId: 'child-1',
      effectiveCapabilities: {},
      delegatedAuthority: { policyVersion: 'policy-1' },
      budget: {},
      depth: 0,
      policyVersion: 'policy-1',
      issuedAt: 0,
      expiresAt: 100,
      revoked: false,
      disclosurePolicy: 'redacted',
      ...overrides,
    },
    'secret',
  );
}

function ledgerEntry(overrides: Partial<DelegationLedgerEntry> = {}): DelegationLedgerEntry {
  return {
    grantId: 'delegation:1',
    childRunId: 'child-2',
    childGrantId: 'delegation:2',
    kind: 'reserve',
    dimension: 'concurrentChildren',
    amount: 1,
    at: 5,
    ...overrides,
  };
}

describe('createChildTopologyStore — child records', () => {
  it('registers a record once and reads it back by child and by parent', async () => {
    const store = createChildTopologyStore(createKv());
    const record = childRecord();

    expect(await store.register(record)).toEqual({ status: 'registered' });
    expect(await store.get('child-1')).toEqual(record);
    expect(await store.listByParent('parent-1')).toEqual([record]);
    expect(await store.listByParent('parent-2')).toEqual([]);
    expect(await store.listAll()).toEqual([record]);
  });

  it('refuses a duplicate registration and hands back the record already there', async () => {
    const store = createChildTopologyStore(createKv());
    const original = childRecord();
    await store.register(original);

    const duplicate = await store.register(childRecord({ childAgentName: 'impostor' }));

    expect(duplicate).toEqual({ status: 'duplicate', existing: original });
    expect(await store.get('child-1')).toEqual(original);
  });

  it('reports a duplicate without a record when the existing one is unreadable', async () => {
    const kv = createKv();
    const corrupt: string[] = [];
    const store = createChildTopologyStore(kv, { onCorrupt: (key) => corrupt.push(key) });
    await kv.set(`${CHILD_RECORD_KEY_PREFIX}child-1`, 'not json');

    expect(await store.register(childRecord())).toEqual({ status: 'duplicate' });
    expect(corrupt).toEqual([`${CHILD_RECORD_KEY_PREFIX}child-1`]);
  });

  it('keeps identifiers containing separators distinct', async () => {
    const store = createChildTopologyStore(createKv());
    const first = childRecord({ parentRunId: 'a:b', childRunId: 'c' });
    const second = childRecord({ parentRunId: 'a', childRunId: 'b:c' });
    await store.register(first);
    await store.register(second);

    expect(await store.listByParent('a:b')).toEqual([first]);
    expect(await store.listByParent('a')).toEqual([second]);
  });

  it('advances the revision on an update against the current revision', async () => {
    const store = createChildTopologyStore(createKv());
    const record = childRecord();
    await store.register(record);

    const update = await store.update(record, { ...record, status: 'completed', updatedAt: 20 });

    expect(update).toEqual({
      status: 'updated',
      record: { ...record, status: 'completed', updatedAt: 20, revision: 2 },
    });
  });

  it('rejects a stale update and returns the current record', async () => {
    const store = createChildTopologyStore(createKv());
    const record = childRecord();
    await store.register(record);
    await store.update(record, { ...record, status: 'aborted' });

    const stale = await store.update(record, { ...record, status: 'completed' });

    expect(stale).toEqual({
      status: 'stale',
      current: { ...record, status: 'aborted', revision: 2 },
    });
  });

  it('lets only one of two writers racing from the same revision win', async () => {
    const store = createChildTopologyStore(createKv());
    const record = childRecord();
    await store.register(record);

    const outcomes = await Promise.all([
      store.update(record, { ...record, status: 'completed' }),
      store.update(record, { ...record, status: 'failed' }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'updated')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'stale')).toHaveLength(1);
  });

  it('treats an update to a missing record as stale with nothing current', async () => {
    const store = createChildTopologyStore(createKv());

    expect(await store.update(childRecord(), childRecord({ status: 'failed' }))).toEqual({
      status: 'stale',
    });
  });

  it('refuses to rewrite one record as another child', async () => {
    const store = createChildTopologyStore(createKv());
    const record = childRecord();
    await store.register(record);

    expect(
      await throwingRejectionOf(store.update(record, { ...record, childRunId: 'child-2' })),
    ).toThrow('cannot change a child record');
  });

  it('skips unreadable records everywhere and reports each key', async () => {
    const kv = createKv();
    const corrupt: string[] = [];
    const store = createChildTopologyStore(kv, { onCorrupt: (key) => corrupt.push(key) });
    const good = childRecord({ childRunId: 'good' });
    await store.register(good);
    await store.register(childRecord({ childRunId: 'bad' }));
    await kv.set(`${CHILD_RECORD_KEY_PREFIX}bad`, JSON.stringify({ schemaVersion: 2 }));

    expect(await store.get('bad')).toBeUndefined();
    expect(await store.listAll()).toEqual([good]);
    expect(await store.listByParent('parent-1')).toEqual([good]);
    const bad = childRecord({ childRunId: 'bad' });
    expect(await store.update(bad, { ...bad, status: 'failed' })).toEqual({ status: 'stale' });
    expect(new Set(corrupt)).toEqual(new Set([`${CHILD_RECORD_KEY_PREFIX}bad`]));
  });

  it('ignores a parent index entry whose record is missing or belongs to another parent', async () => {
    const kv = createKv();
    const store = createChildTopologyStore(kv);
    const record = childRecord();
    await store.register(record);
    await kv.set('bureau-child:parent:parent-2:child-1', '1');
    await kv.set('bureau-child:parent:parent-1:ghost', '1');

    expect(await store.listByParent('parent-2')).toEqual([]);
    expect(await store.listByParent('parent-1')).toEqual([record]);
  });

  it.each([
    ['a non-object', 7],
    ['an unknown status', { status: 'paused' }],
    ['a zero revision', { revision: 0 }],
    ['a negative recovery count', { recoveries: -1 }],
    ['an unknown workflow kind', { workflow: { kind: 'remote' } }],
    ['a durable workflow without an id', { workflow: { kind: 'durable', workflowType: 'x' } }],
    ['a missing workflow', { workflow: null }],
    ['an unknown cancellation policy', { parentCancellation: 'ignore' }],
    ['a non-string principal', { principal: 7 }],
    ['a non-string grant', { grantId: 7 }],
    ['a non-string parent grant', { parentGrantId: 7 }],
    ['a non-number settledAt', { settledAt: 'later' }],
    ['a non-number reattachedAt', { reattachedAt: 'later' }],
    ['a non-object outcome', { outcome: 'done' }],
    ['an outcome with a numeric reason', { outcome: { reason: 7 } }],
    ['an outcome with a numeric finish reason', { outcome: { finishReason: 7 } }],
    ['an outcome with numeric content', { outcome: { content: 7 } }],
    ['a non-string parent agent', { parentAgentName: 7 }],
    ['a non-number createdAt', { createdAt: '0' }],
  ])('treats a stored record with %s as unreadable', async (_label, patch) => {
    const kv = createKv();
    const store = createChildTopologyStore(kv);
    const value = typeof patch === 'object' ? { ...childRecord(), ...patch } : patch;
    await kv.set(`${CHILD_RECORD_KEY_PREFIX}child-1`, JSON.stringify(value));

    expect(await store.get('child-1')).toBeUndefined();
  });

  it('reads back a record carrying every optional field', async () => {
    const store = createChildTopologyStore(createKv());
    const full = childRecord({
      status: 'completed',
      settledAt: 30,
      reattachedAt: 20,
      recoveries: 1,
      principal: 'owner',
      grantId: 'delegation:2',
      parentGrantId: 'delegation:1',
      workflow: { kind: 'process-local' },
      outcome: { finishReason: 'stop-condition', content: 'done', reason: 'why' },
    });
    await store.register(full);

    expect(await store.get('child-1')).toEqual(full);
  });
});

describe('createChildTopologyStore — delegation grants', () => {
  it('issues a grant once and loads it back', async () => {
    const store = createChildTopologyStore(createKv());
    const issued = grant();

    expect(await store.issueGrant(issued)).toBe(true);
    expect(await store.issueGrant(grant({ objective: 'other' }))).toBe(false);
    expect(await store.loadGrant(issued.id)).toEqual({ status: 'found', grant: issued });
  });

  it('distinguishes a missing grant from an unreadable one', async () => {
    const kv = createKv();
    const corrupt: string[] = [];
    const store = createChildTopologyStore(kv, { onCorrupt: (key) => corrupt.push(key) });
    await kv.set(`${DELEGATION_GRANT_KEY_PREFIX}broken`, '{"version":1}');

    expect(await store.loadGrant('absent')).toEqual({ status: 'missing' });
    expect(await store.loadGrant('broken')).toEqual({ status: 'corrupt' });
    expect(corrupt).toEqual([`${DELEGATION_GRANT_KEY_PREFIX}broken`]);
  });

  it('replaces a grant only when the stored one still matches', async () => {
    const store = createChildTopologyStore(createKv());
    const issued = grant();
    await store.issueGrant(issued);
    const revoked = grant({ revoked: true });

    expect(await store.replaceGrant(issued, revoked)).toBe(true);
    expect(await store.replaceGrant(issued, grant({ objective: 'again' }))).toBe(false);
    expect(await store.loadGrant(issued.id)).toEqual({ status: 'found', grant: revoked });
    expect(await store.replaceGrant(grant({ id: 'absent' }), revoked)).toBe(false);
  });
});

describe('createChildTopologyStore — budget ledger', () => {
  it('appends each entry once and lists only the requested grant', async () => {
    const store = createChildTopologyStore(createKv());
    const reserve = ledgerEntry();
    const release = ledgerEntry({ kind: 'release', at: 9 });
    const other = ledgerEntry({ grantId: 'delegation:2' });
    // A second attempt at the same child holds a reservation of its own.
    const secondAttempt = ledgerEntry({ childGrantId: 'delegation:3' });

    expect(await store.appendLedgerEntry(reserve)).toBe(true);
    expect(await store.appendLedgerEntry({ ...reserve, at: 99 })).toBe(false);
    expect(await store.appendLedgerEntry(release)).toBe(true);
    expect(await store.appendLedgerEntry(other)).toBe(true);
    expect(await store.appendLedgerEntry(secondAttempt)).toBe(true);

    const entries = await store.listLedger('delegation:1');
    expect(entries).toHaveLength(3);
    expect(entries).toContainEqual(reserve);
    expect(entries).toContainEqual(release);
    expect(entries).toContainEqual(secondAttempt);
  });

  it('skips an unreadable ledger entry and reports its key', async () => {
    const kv = createKv();
    const corrupt: string[] = [];
    const store = createChildTopologyStore(kv, { onCorrupt: (key) => corrupt.push(key) });
    await store.appendLedgerEntry(ledgerEntry());
    const brokenKey = `${DELEGATION_LEDGER_KEY_PREFIX}delegation%3A1:broken`;
    await kv.set(brokenKey, JSON.stringify({ kind: 'spend' }));

    expect(await store.listLedger('delegation:1')).toEqual([ledgerEntry()]);
    expect(corrupt).toEqual([brokenKey]);
  });
});
