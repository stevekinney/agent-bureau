import { describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from 'lifecycle';

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
