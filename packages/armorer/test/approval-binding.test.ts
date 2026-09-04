import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

import {
  APPROVAL_BINDING_VERSION,
  ApprovalBindingError,
  createProcessLocalApprovalStateStore,
  createProcessLocalGrantStateStore,
  GRANT_VERSION,
  GrantError,
  type ReusableApprovalGrant,
  signGrant,
  validateApprovalBinding,
  verifyGrantSignature,
} from '../src/approval-binding';

const binding = {
  version: APPROVAL_BINDING_VERSION,
  principalId: 'principal',
  tenantId: 'tenant',
  ownerId: 'owner',
  authorizationRevision: 'authorization:1',
  capabilitiesRevision: '["tools:execute"]',
  audience: 'tenant',
  agentId: 'agent',
  runId: 'run',
  toolboxRevision: 'toolbox-1',
  toolDefinitionRevision: 'tools-1',
  policyRevision: 'policy-1',
  approvalRevision: 'approval-1',
  issuedAt: 10_000_000_000_000,
  expiresAt: 10_000_000_000_200,
  nonce: 'nonce',
  replayScope: 'run',
} as const;

describe('approval binding state', () => {
  it('validates expiry and binding context', () => {
    expect(() =>
      validateApprovalBinding(binding, { tenantId: 'other' }, 10_000_000_000_150),
    ).toThrow('tenantId does not match');
    expect(() => validateApprovalBinding(binding, undefined, 10_000_000_000_200)).toThrow(
      'expired',
    );
    expect(() => validateApprovalBinding({ ...binding, issuedAt: 10_000_000_000_200 })).toThrow(
      'Invalid approval binding',
    );
    expect(() => validateApprovalBinding({ ...binding, version: 2 as never })).toThrow(
      ApprovalBindingError,
    );
  });

  it('rejects non-finite binding timestamps and validation time', () => {
    const nonFiniteValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const issuedAt of nonFiniteValues) {
      expect(() => validateApprovalBinding({ ...binding, issuedAt })).toThrow(ApprovalBindingError);
    }
    for (const expiresAt of nonFiniteValues) {
      expect(() => validateApprovalBinding({ ...binding, expiresAt })).toThrow(
        ApprovalBindingError,
      );
    }
    for (const now of nonFiniteValues) {
      expect(() => validateApprovalBinding(binding, undefined, now)).toThrow(ApprovalBindingError);
    }
  });

  it('rejects bindings with missing or incorrectly typed required fields', () => {
    const missingApprovalRevision = { ...binding } as Record<string, unknown>;
    delete missingApprovalRevision['approvalRevision'];
    expect(() => validateApprovalBinding(missingApprovalRevision as never)).toThrow(
      'Invalid approval binding',
    );
    expect(() => validateApprovalBinding({ ...binding, audience: 'internal' as never })).toThrow(
      'Invalid approval binding',
    );
    expect(() => validateApprovalBinding({ ...binding, nonce: 123 as never })).toThrow(
      'Invalid approval binding',
    );
  });

  it('rejects non-finite process-local store clocks before reading or mutating state', async () => {
    const store = createProcessLocalApprovalStateStore(() => Number.POSITIVE_INFINITY);

    await expect(store.issue(binding)).rejects.toMatchObject({ code: 'invalid-binding' });
    await expect(store.consume(binding)).rejects.toMatchObject({ code: 'invalid-binding' });
    await expect(store.revoke(binding)).rejects.toMatchObject({ code: 'invalid-binding' });
    await expect(store.state(binding)).rejects.toMatchObject({ code: 'invalid-binding' });
  });

  it('issues, atomically consumes once, and tracks revocation', async () => {
    const store = createProcessLocalApprovalStateStore();
    await store.issue(binding);
    await expect(store.state(binding)).resolves.toBe('issued');
    await store.consume(binding, { runId: 'run' }, 10_000_000_000_150);
    await expect(store.state(binding)).resolves.toBe('consumed');
    await expect(store.consume(binding, undefined, 10_000_000_000_150)).rejects.toMatchObject({
      code: 'already-consumed',
    });
    await expect(store.issue(binding)).rejects.toMatchObject({ code: 'already-consumed' });
  });

  it('rejects unknown and revoked bindings', async () => {
    const store = createProcessLocalApprovalStateStore();
    await expect(store.consume(binding, undefined, 10_000_000_000_150)).rejects.toMatchObject({
      code: 'not-found',
    });
    await store.issue(binding);
    await store.revoke(binding);
    await expect(store.state(binding)).resolves.toBe('revoked');
    await expect(store.consume(binding, undefined, 10_000_000_000_150)).rejects.toMatchObject({
      code: 'revoked',
    });
    await store.revoke(binding);
    await expect(store.state(binding)).resolves.toBe('revoked');
  });

  it('atomically revokes a reserved approval before it can commit', async () => {
    const store = createProcessLocalApprovalStateStore();
    await store.issue(binding);
    await Promise.all([
      store.reserve(binding, undefined, 10_000_000_000_150),
      store.revoke(binding),
    ]);

    await expect(store.state(binding)).resolves.toBe('revoked');
    await expect(store.commit(binding)).rejects.toMatchObject({ code: 'revoked' });
  });

  it('rejects a payload that differs from the issued binding', async () => {
    const store = createProcessLocalApprovalStateStore();
    await store.issue(binding);
    await expect(
      store.consume({ ...binding, agentId: 'other-agent' }, undefined, 10_000_000_000_150),
    ).rejects.toMatchObject({
      code: 'mismatch',
    });
  });

  it('snapshots issued bindings against post-verification caller mutation', async () => {
    const store = createProcessLocalApprovalStateStore();
    const mutableBinding = { ...binding };
    await store.issue(mutableBinding);

    mutableBinding.expiresAt += 1_000;

    await expect(
      store.reserve(mutableBinding, undefined, 10_000_000_000_150),
    ).rejects.toMatchObject({ code: 'mismatch' });
    await expect(store.state(binding)).resolves.toBe('issued');
  });

  it('rejects cross-principal and cross-tenant replay and consumes concurrently once', async () => {
    const store = createProcessLocalApprovalStateStore();
    await store.issue(binding);

    await expect(
      store.consume(binding, { principalId: 'principal-b' }, 10_000_000_000_150),
    ).rejects.toMatchObject({ code: 'mismatch' });
    await expect(
      store.consume(binding, { tenantId: 'tenant-b' }, 10_000_000_000_150),
    ).rejects.toMatchObject({ code: 'mismatch' });

    const attempts = await Promise.allSettled([
      store.consume(binding, { principalId: 'principal' }, 10_000_000_000_150),
      store.consume(binding, { principalId: 'principal' }, 10_000_000_000_150),
    ]);
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });

  it('evicts expired issued and terminal records', async () => {
    const runtime = createManualRuntimeServices();
    const store = createProcessLocalApprovalStateStore(runtime.clock.now);
    const now = runtime.clock.now();
    const expiringBinding = {
      ...binding,
      issuedAt: now - 1,
      expiresAt: now + 10,
      nonce: 'expiring',
    };
    await store.issue(expiringBinding);
    await store.consume(expiringBinding, undefined, now);
    await runtime.advance(12);
    await expect(store.state(expiringBinding)).resolves.toBeUndefined();

    const replacement = {
      ...expiringBinding,
      issuedAt: runtime.clock.now(),
      expiresAt: runtime.clock.now() + 1_000,
    };
    await expect(store.issue(replacement)).resolves.toBeUndefined();
  });
});

const grantSecret = 'grant-secret';

function buildGrant(overrides: Partial<ReusableApprovalGrant> = {}): ReusableApprovalGrant {
  const base: ReusableApprovalGrant = {
    version: GRANT_VERSION,
    id: 'grant:nonce-1',
    principalId: 'principal',
    tenantId: 'tenant',
    ownerId: 'owner',
    agentId: 'agent',
    toolName: 'tool',
    resourcePattern: 'resource:*',
    argumentConstraints: { path: 'string' },
    scope: 'run',
    issuedAt: 10_000_000_000_000,
    expiresAt: 10_000_000_000_200,
    maxUses: 3,
    usesRemaining: 3,
    policyRevision: 'policy-1',
    revoked: false,
    delegationBehavior: 'does-not-propagate',
    signature: '',
    ...overrides,
  };
  return { ...base, signature: overrides.signature ?? signGrant(base, grantSecret) };
}

describe('reusable approval grant state', () => {
  it('exports GRANT_VERSION as 1', () => {
    expect(GRANT_VERSION).toBe(1);
  });

  it('issues a grant, initializing usesRemaining to maxUses', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant({ maxUses: 5, usesRemaining: 5 });
    await store.issue(grant);
    await expect(store.get(grant.id)).resolves.toEqual(grant);
  });

  it('initializes usesRemaining to maxUses even if a different value is supplied on issue', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant({ maxUses: 5, usesRemaining: 5 });
    const tampered = { ...grant, usesRemaining: 999 };
    await store.issue(tampered);
    await expect(store.get(grant.id)).resolves.toEqual({ ...grant, usesRemaining: 5 });
  });

  it('lists every issued grant', async () => {
    const store = createProcessLocalGrantStateStore();
    const first = buildGrant({ id: 'grant:first' });
    const second = buildGrant({ id: 'grant:second' });
    await store.issue(first);
    await store.issue(second);
    await expect(store.list()).resolves.toEqual(expect.arrayContaining([first, second]));
    await expect(store.list()).resolves.toHaveLength(2);
  });

  it('returns undefined from get for an unknown grant id', async () => {
    const store = createProcessLocalGrantStateStore();
    await expect(store.get('grant:unknown')).resolves.toBeUndefined();
  });

  it('revokes a grant, setting revoked to true', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant();
    await store.issue(grant);
    await store.revoke(grant.id);
    const revoked = await store.get(grant.id);
    expect(revoked?.revoked).toBe(true);
  });

  it('revoking an already-revoked grant is idempotent and does not throw', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant();
    await store.issue(grant);
    await store.revoke(grant.id);
    await expect(store.revoke(grant.id)).resolves.toBeUndefined();
    const revoked = await store.get(grant.id);
    expect(revoked?.revoked).toBe(true);
  });

  it('revoking an unknown grant does not throw', async () => {
    const store = createProcessLocalGrantStateStore();
    await expect(store.revoke('grant:unknown')).resolves.toBeUndefined();
  });

  it('decrements usesRemaining and returns the new value', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant({ maxUses: 2, usesRemaining: 2 });
    await store.issue(grant);
    await expect(store.decrementUse(grant.id)).resolves.toEqual({ usesRemaining: 1 });
    await expect(store.decrementUse(grant.id)).resolves.toEqual({ usesRemaining: 0 });
    const decremented = await store.get(grant.id);
    expect(decremented?.usesRemaining).toBe(0);
  });

  it('never decrements usesRemaining below zero', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant({ maxUses: 1, usesRemaining: 1 });
    await store.issue(grant);
    await store.decrementUse(grant.id);
    await expect(store.decrementUse(grant.id)).resolves.toEqual({ usesRemaining: 0 });
    await expect(store.decrementUse(grant.id)).resolves.toEqual({ usesRemaining: 0 });
  });

  it('throws GrantError with code not-found when decrementing an unknown grant', async () => {
    const store = createProcessLocalGrantStateStore();
    await expect(store.decrementUse('grant:unknown')).rejects.toThrow(GrantError);
    await expect(store.decrementUse('grant:unknown')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('only decrementUse mutates usesRemaining; issue, get, list, and revoke never touch it', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant({ maxUses: 4, usesRemaining: 4 });
    await store.issue(grant);
    await store.revoke(grant.id);
    const listed = await store.list();
    const fromList = listed.find((entry) => entry.id === grant.id);
    expect(fromList?.usesRemaining).toBe(4);
    const fetched = await store.get(grant.id);
    expect(fetched?.usesRemaining).toBe(4);
  });

  it('is not affected by mutating the object passed to issue after the call', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant({ argumentConstraints: { path: 'string' } });
    const mutableConstraints = grant.argumentConstraints as Record<string, unknown>;
    await store.issue(grant);
    mutableConstraints['path'] = 'tampered';

    const fetched = await store.get(grant.id);
    expect(fetched?.argumentConstraints).toEqual({ path: 'string' });
  });

  it('is not affected by mutating an object returned from get or list', async () => {
    const store = createProcessLocalGrantStateStore();
    const grant = buildGrant({ argumentConstraints: { path: 'string' } });
    await store.issue(grant);

    const fetched = await store.get(grant.id);
    (fetched as { usesRemaining: number }).usesRemaining = 999;
    (fetched?.argumentConstraints as Record<string, unknown>)['path'] = 'tampered';

    const listed = await store.list();
    const fromList = listed[0] as { usesRemaining: number };
    fromList.usesRemaining = 999;

    const refetched = await store.get(grant.id);
    expect(refetched?.usesRemaining).toBe(grant.maxUses);
    expect(refetched?.argumentConstraints).toEqual({ path: 'string' });
  });
});

describe('reusable approval grant signing', () => {
  it('produces a signature that verifies against the grant it was signed for', () => {
    const grant = buildGrant();
    expect(() => verifyGrantSignature(grant, grantSecret)).not.toThrow();
  });

  it('rejects a grant whose signature does not match its current field values', () => {
    const grant = buildGrant();
    const tampered = { ...grant, usesRemaining: grant.usesRemaining - 1 };
    expect(() => verifyGrantSignature(tampered, grantSecret)).toThrow(GrantError);
    expect(() => verifyGrantSignature(tampered, grantSecret)).toThrow(
      'Reusable approval grant signature is invalid.',
    );
  });

  it('rejects a grant signed with a different secret', () => {
    const grant = buildGrant();
    expect(() => verifyGrantSignature(grant, 'a-different-secret')).toThrow(GrantError);
  });

  it('produces a different signature for a tampered maxUses field, even if usesRemaining matches', () => {
    const grant = buildGrant({ maxUses: 3, usesRemaining: 3 });
    const tampered = { ...grant, maxUses: 30 };
    expect(signGrant(tampered, grantSecret)).not.toBe(grant.signature);
  });
});
