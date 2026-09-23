import type { JSONValue } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { recoveredRequestContextFromMetadata } from './session-request-context';

const fixedNow = 1_700_000_000_000;
const now = () => fixedNow;

function authorityMetadata(
  audience: JSONValue | undefined,
  storageShape: 'per-run' | 'legacy',
): Record<string, JSONValue> {
  const authority = {
    principalId: 'principal-1',
    tenantId: 'tenant-1',
    ownerId: 'owner-1',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization-7',
    ...(audience === undefined ? {} : { audience }),
  };
  return storageShape === 'per-run'
    ? { lastRequestAuthorities: { 'run-1': authority } }
    : { lastRequestAuthority: authority };
}

const invalidAudiences: { audience: JSONValue }[] = [
  { audience: 'unknown' },
  { audience: '' },
  { audience: 0 },
  { audience: null },
  { audience: [] },
  { audience: {} },
];

describe.each(['per-run', 'legacy'] as const)(
  'persisted request context audience: %s',
  (storageShape) => {
    it.each(invalidAudiences)('rejects malformed audience $audience', ({ audience }) => {
      expect(
        recoveredRequestContextFromMetadata(
          authorityMetadata(audience, storageShape),
          'run-1',
          'session-1',
          'agent-1',
          now,
        ),
      ).toBeUndefined();
    });

    it.each(['public', 'tenant', 'operator'])('preserves the supported %s audience', (audience) => {
      expect(
        recoveredRequestContextFromMetadata(
          authorityMetadata(audience, storageShape),
          'run-1',
          'session-1',
          'agent-1',
          now,
        )?.audience,
      ).toBe(audience);
    });

    it('retains the operator default when no audience is stored', () => {
      expect(
        recoveredRequestContextFromMetadata(
          authorityMetadata(undefined, storageShape),
          'run-1',
          'session-1',
          'agent-1',
          now,
        )?.audience,
      ).toBe('operator');
    });
  },
);

describe('recoveredRequestContextFromMetadata', () => {
  it('rebuilds only valid persisted request authority for recovered runs', () => {
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-authorized': {
              agentId: 'per-run-billing-agent',
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: ['tools:execute', 'payments:charge'],
              authorizationRevision: 'authorization-7',
              audience: 'operator',
            },
          },
        },
        'run-authorized',
        'session-recovery',
        'billing-agent',
        now,
      ),
    ).toEqual({
      authority: {
        principalId: 'principal-1',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        capabilities: ['tools:execute', 'payments:charge'],
        authorizationRevision: 'authorization-7',
      },
      audience: 'operator',
      agentId: 'per-run-billing-agent',
      runId: 'run-authorized',
      sessionId: 'session-recovery',
    });

    expect(
      recoveredRequestContextFromMetadata(
        { lastRequestAuthorities: { 'other-run': {} } },
        'run-missing',
        'session-recovery',
        'billing-agent',
        now,
      ),
    ).toBeUndefined();

    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthority: {
            principalId: 'api-key:legacy',
            tenantId: 'tenant-1',
            ownerId: 'owner-1',
            capabilities: ['tools:execute'],
            authorizationRevision: 'gateway:api-key:legacy',
          },
        },
        'legacy-run',
        'session-recovery',
        'billing-agent',
        now,
      ),
    ).toEqual({
      authority: {
        principalId: 'api-key:legacy',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        capabilities: ['tools:execute'],
        authorizationRevision: 'gateway:api-key:legacy',
      },
      audience: 'operator',
      agentId: 'billing-agent',
      runId: 'legacy-run',
      sessionId: 'session-recovery',
    });
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-malformed': {
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: [42],
              authorizationRevision: 'authorization-7',
            },
          },
        },
        'run-malformed',
        'session-recovery',
        'billing-agent',
        now,
      ),
    ).toBeUndefined();

    const futureDeadline = fixedNow + 60_000;
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-deadline': {
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: ['tools:execute'],
              authorizationRevision: 'authorization-7',
              deadline: futureDeadline,
            },
          },
        },
        'run-deadline',
        'session-recovery',
        'billing-agent',
        now,
      )?.deadline,
    ).toBe(futureDeadline);
    expect(
      recoveredRequestContextFromMetadata(
        {
          lastRequestAuthorities: {
            'run-expired': {
              principalId: 'principal-1',
              tenantId: 'tenant-1',
              ownerId: 'owner-1',
              capabilities: ['tools:execute'],
              authorizationRevision: 'authorization-7',
              deadline: fixedNow - 1,
            },
          },
        },
        'run-expired',
        'session-recovery',
        'billing-agent',
        now,
      ),
    ).toBeUndefined();
  });
});
