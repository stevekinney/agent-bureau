/**
 * Delegation grants (COR-336's decision record, first implemented for
 * COR-772): the signed, tamper-evident authority record for one child
 * dispatch, plus the monotonic attenuation helpers a dispatcher composes a
 * child's grant from.
 */
import { describe, expect, it } from 'bun:test';

import {
  attenuateDelegationBudget,
  attenuateDelegationCapabilities,
  DELEGATION_GRANT_VERSION,
  type DelegationGrant,
  digestDelegationArtifact,
  isDelegationGrant,
  revokeDelegationGrant,
  signDelegationGrant,
  type UnsignedDelegationGrant,
  verifyDelegationGrant,
} from './delegation-grant';

const SECRET = 'delegation-test-secret';

function unsignedGrant(overrides: Partial<UnsignedDelegationGrant> = {}): UnsignedDelegationGrant {
  return {
    version: DELEGATION_GRANT_VERSION,
    id: 'delegation:1',
    parentRunId: 'parent-1',
    childRunId: 'child-1',
    agentName: 'worker',
    agentVersion: '1',
    objective: 'summarize the report',
    recipientId: 'child-1',
    effectiveCapabilities: { tools: ['read'], network: false },
    delegatedAuthority: { policyVersion: 'policy-1' },
    budget: { concurrentChildren: 2, totalDescendants: 4, steps: 10 },
    depth: 1,
    policyVersion: 'policy-1',
    issuedAt: 1_000,
    expiresAt: 2_000,
    revoked: false,
    disclosurePolicy: 'redacted',
    ...overrides,
  };
}

describe('signDelegationGrant / verifyDelegationGrant', () => {
  it('accepts an untampered, unexpired, unrevoked grant', () => {
    const grant = signDelegationGrant(unsignedGrant(), SECRET);

    expect(grant.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyDelegationGrant(grant, SECRET, 1_500)).toEqual({ valid: true });
  });

  it('signs the canonical payload, so key order never changes the signature', () => {
    const forward = signDelegationGrant(unsignedGrant(), SECRET);
    const reordered = signDelegationGrant(
      {
        disclosurePolicy: 'redacted',
        revoked: false,
        expiresAt: 2_000,
        issuedAt: 1_000,
        policyVersion: 'policy-1',
        depth: 1,
        budget: { steps: 10, totalDescendants: 4, concurrentChildren: 2 },
        delegatedAuthority: { policyVersion: 'policy-1' },
        effectiveCapabilities: { network: false, tools: ['read'] },
        recipientId: 'child-1',
        objective: 'summarize the report',
        agentVersion: '1',
        agentName: 'worker',
        childRunId: 'child-1',
        parentRunId: 'parent-1',
        id: 'delegation:1',
        version: DELEGATION_GRANT_VERSION,
      },
      SECRET,
    );

    expect(reordered.signature).toBe(forward.signature);
  });

  it('ignores absent optional fields when signing', () => {
    const withoutDigest = signDelegationGrant(unsignedGrant(), SECRET);
    const withUndefinedDigest = signDelegationGrant(
      { ...unsignedGrant(), artifactDigest: undefined },
      SECRET,
    );

    expect(withUndefinedDigest.signature).toBe(withoutDigest.signature);
  });

  it.each([
    ['a widened budget ceiling', { budget: { concurrentChildren: 99 } }],
    ['a widened capability', { effectiveCapabilities: { tools: ['read', 'write'] } }],
    ['a different parent', { parentRunId: 'someone-else' }],
    ['an extended expiry', { expiresAt: 9_999 }],
    ['a deeper depth', { depth: 5 }],
  ] as const)('rejects a grant tampered with %s as invalid-signature', (_label, tamper) => {
    const grant = signDelegationGrant(unsignedGrant(), SECRET);
    const tampered = { ...grant, ...tamper } as DelegationGrant;

    const verification = verifyDelegationGrant(tampered, SECRET, 1_500);

    expect(verification).toMatchObject({ valid: false, code: 'invalid-signature' });
  });

  it('rejects a grant verified under a different secret', () => {
    const grant = signDelegationGrant(unsignedGrant(), SECRET);

    expect(verifyDelegationGrant(grant, 'another-secret', 1_500)).toMatchObject({
      valid: false,
      code: 'invalid-signature',
    });
  });

  it('rejects a grant at or after its expiry', () => {
    const grant = signDelegationGrant(unsignedGrant(), SECRET);

    expect(verifyDelegationGrant(grant, SECRET, 2_000)).toMatchObject({
      valid: false,
      code: 'expired',
    });
  });

  it('rejects a grant from an unsupported version before checking anything else', () => {
    const grant = signDelegationGrant(unsignedGrant(), SECRET);
    const future = { ...grant, version: 2 } as unknown as DelegationGrant;

    expect(verifyDelegationGrant(future, SECRET, 1_500)).toMatchObject({
      valid: false,
      code: 'unsupported-version',
    });
  });

  it('revokes by re-signing, so revocation is distinguishable from tampering', () => {
    const grant = signDelegationGrant(unsignedGrant(), SECRET);
    const revoked = revokeDelegationGrant(grant, SECRET);

    expect(revoked.revoked).toBe(true);
    expect(revoked.signature).not.toBe(grant.signature);
    expect(verifyDelegationGrant(revoked, SECRET, 1_500)).toMatchObject({
      valid: false,
      code: 'revoked',
    });
  });

  it('treats un-revoking a revoked grant without the secret as tampering', () => {
    const revoked = revokeDelegationGrant(signDelegationGrant(unsignedGrant(), SECRET), SECRET);
    const unrevoked = { ...revoked, revoked: false };

    expect(verifyDelegationGrant(unrevoked, SECRET, 1_500)).toMatchObject({
      valid: false,
      code: 'invalid-signature',
    });
  });
});

describe('isDelegationGrant', () => {
  const valid = signDelegationGrant(
    unsignedGrant({
      artifactDigest: 'a'.repeat(64),
      effectiveCapabilities: {
        tools: ['read'],
        pathPatterns: ['src/**'],
        network: ['example.com'],
        secrets: ['token'],
        admin: true,
      },
      delegatedAuthority: {
        grantedProviders: ['anthropic'],
        grantedModels: ['model-a'],
        maximumEffort: 'high',
        policyVersion: 'policy-1',
      },
      budget: {
        concurrentChildren: 1,
        totalDescendants: 1,
        duration: 1,
        steps: 1,
        tokens: 1,
        cost: 1,
        toolCalls: 1,
      },
    }),
    SECRET,
  );

  it('accepts a fully populated signed grant', () => {
    expect(isDelegationGrant(valid)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'grant'],
    ['a wrong version', { ...valid, version: 2 }],
    ['a missing id', { ...valid, id: undefined }],
    ['a non-string parent', { ...valid, parentRunId: 7 }],
    ['a non-string child', { ...valid, childRunId: 7 }],
    ['a non-string agent name', { ...valid, agentName: 7 }],
    ['a non-string agent version', { ...valid, agentVersion: 7 }],
    ['a non-string objective', { ...valid, objective: 7 }],
    ['a non-string recipient', { ...valid, recipientId: 7 }],
    ['a non-string policy version', { ...valid, policyVersion: 7 }],
    ['a non-string signature', { ...valid, signature: 7 }],
    ['a non-integer depth', { ...valid, depth: 1.5 }],
    ['a negative depth', { ...valid, depth: -1 }],
    ['a non-number issuedAt', { ...valid, issuedAt: '1' }],
    ['a non-number expiresAt', { ...valid, expiresAt: '2' }],
    ['a non-boolean revoked', { ...valid, revoked: 'no' }],
    ['an unknown disclosure policy', { ...valid, disclosurePolicy: 'everything' }],
    ['a non-string artifact digest', { ...valid, artifactDigest: 7 }],
    ['missing capabilities', { ...valid, effectiveCapabilities: null }],
    ['a non-array tool list', { ...valid, effectiveCapabilities: { tools: 'read' } }],
    ['a non-string tool', { ...valid, effectiveCapabilities: { tools: [7] } }],
    ['a non-array path list', { ...valid, effectiveCapabilities: { pathPatterns: 'src' } }],
    ['a non-array secret list', { ...valid, effectiveCapabilities: { secrets: 'token' } }],
    ['a numeric network', { ...valid, effectiveCapabilities: { network: 1 } }],
    ['a network list with a number', { ...valid, effectiveCapabilities: { network: [1] } }],
    ['a numeric admin', { ...valid, effectiveCapabilities: { admin: 1 } }],
    ['missing budget', { ...valid, budget: null }],
    ['a negative budget', { ...valid, budget: { steps: -1 } }],
    ['a non-numeric budget', { ...valid, budget: { cost: 'free' } }],
    ['an infinite budget', { ...valid, budget: { tokens: Number.POSITIVE_INFINITY } }],
    ['a malformed delegated authority', { ...valid, delegatedAuthority: { policyVersion: 7 } }],
  ])('rejects %s', (_label, candidate) => {
    expect(isDelegationGrant(candidate)).toBe(false);
  });
});

describe('attenuateDelegationCapabilities', () => {
  it('intersects allow-lists and treats an absent side as no narrowing', () => {
    expect(
      attenuateDelegationCapabilities(
        { tools: ['read', 'write'], pathPatterns: ['src/**'] },
        { tools: ['write', 'deploy'], secrets: ['token'] },
      ),
    ).toEqual({ tools: ['write'], pathPatterns: ['src/**'], secrets: ['token'] });
  });

  it('returns the requested capabilities unchanged when there is no parent', () => {
    expect(attenuateDelegationCapabilities(undefined, { tools: ['read'] })).toEqual({
      tools: ['read'],
    });
    expect(attenuateDelegationCapabilities(undefined, undefined)).toEqual({});
  });

  it('never lets a child regain a switch an ancestor turned off', () => {
    expect(attenuateDelegationCapabilities({ network: false }, { network: true })).toEqual({
      network: false,
    });
    expect(attenuateDelegationCapabilities({ admin: true }, { admin: false })).toEqual({
      admin: false,
    });
    expect(attenuateDelegationCapabilities({ network: false }, { network: ['a.com'] })).toEqual({
      network: false,
    });
  });

  it('narrows an unrestricted switch to the other side and intersects two lists', () => {
    expect(attenuateDelegationCapabilities({ network: true }, { network: ['a.com'] })).toEqual({
      network: ['a.com'],
    });
    expect(attenuateDelegationCapabilities({ admin: ['issue'] }, { admin: true })).toEqual({
      admin: ['issue'],
    });
    expect(
      attenuateDelegationCapabilities({ network: ['a.com', 'b.com'] }, { network: ['b.com'] }),
    ).toEqual({ network: ['b.com'] });
    expect(attenuateDelegationCapabilities({ network: true }, { network: true })).toEqual({
      network: true,
    });
  });
});

describe('attenuateDelegationBudget', () => {
  it('takes the lower ceiling per dimension and inherits an absent dimension', () => {
    expect(
      attenuateDelegationBudget(
        { concurrentChildren: 3, steps: 100, tokens: 500 },
        { concurrentChildren: 5, steps: 10, cost: 2 },
      ),
    ).toEqual({ concurrentChildren: 3, steps: 10, tokens: 500, cost: 2 });
  });

  it('returns the requested budget when there is no parent', () => {
    expect(attenuateDelegationBudget(undefined, { toolCalls: 4 })).toEqual({ toolCalls: 4 });
    expect(attenuateDelegationBudget(undefined, undefined)).toEqual({});
  });
});

describe('digestDelegationArtifact', () => {
  it('is a stable SHA-256 digest of the canonical form', () => {
    const forward = digestDelegationArtifact({ a: 1, b: [1, { c: 'x' }] });
    const reordered = digestDelegationArtifact({ b: [1, { c: 'x' }], a: 1 });

    expect(forward).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(forward);
    expect(digestDelegationArtifact({ a: 2 })).not.toBe(forward);
  });
});
