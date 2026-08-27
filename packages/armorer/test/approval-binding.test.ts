import { describe, expect, it } from 'bun:test';

import {
  APPROVAL_BINDING_VERSION,
  ApprovalBindingError,
  createProcessLocalApprovalStateStore,
  validateApprovalBinding,
} from '../src/approval-binding';

const binding = {
  version: APPROVAL_BINDING_VERSION,
  principalId: 'principal',
  tenantId: 'tenant',
  audience: 'tenant',
  agentId: 'agent',
  runId: 'run',
  toolboxRevision: 'toolbox-1',
  toolDefinitionRevision: 'tools-1',
  policyRevision: 'policy-1',
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

  it('rejects a payload that differs from the issued binding', async () => {
    const store = createProcessLocalApprovalStateStore();
    await store.issue(binding);
    await expect(
      store.consume({ ...binding, agentId: 'other-agent' }, undefined, 10_000_000_000_150),
    ).rejects.toMatchObject({
      code: 'mismatch',
    });
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
    const store = createProcessLocalApprovalStateStore();
    const now = Date.now();
    const expiringBinding = {
      ...binding,
      issuedAt: now - 1,
      expiresAt: now + 10,
      nonce: 'expiring',
    };
    await store.issue(expiringBinding);
    await store.consume(expiringBinding, undefined, now);
    await new Promise((resolve) => setTimeout(resolve, 12));
    await expect(store.state(expiringBinding)).resolves.toBeUndefined();

    const replacement = {
      ...expiringBinding,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 1_000,
    };
    await expect(store.issue(replacement)).resolves.toBeUndefined();
  });
});
