import { describe, expect, it } from 'bun:test';
import {
  isSessionAuthorityAuthorized,
  isSessionRunTerminal,
  recordedSessionAuthorityPrincipalId,
  resolvePersistedRunOwningPrincipal,
} from './session-authority';

describe('recordedSessionAuthorityPrincipalId / isSessionAuthorityAuthorized (AB-194)', () => {
  it('returns undefined when the session has recorded no authority at all', () => {
    expect(recordedSessionAuthorityPrincipalId({})).toBeUndefined();
  });

  it('reads the per-run principalId from lastRequestAuthorities keyed by lastRunId', () => {
    const principalId = recordedSessionAuthorityPrincipalId({
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'run-1': {
          principalId: 'alice',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    });
    expect(principalId).toBe('alice');
  });

  it('does NOT fall back to legacy when lastRequestAuthorities is non-empty but uncorrelated to lastRunId (concurrent-run shape) — fails closed instead', () => {
    // Regression (Codex review, fifth pass): a non-empty map holding some
    // OTHER run's entry, alongside a legacy field, is exactly the shape two
    // concurrent runs on one session produce — run B's dispatch overwrites
    // the singular legacy field with B's authority while A is still running;
    // A's own terminal cleanup later prunes only A's key, leaving B's
    // (unrelated) entry and B's legacy authority behind. Trusting legacy
    // here would authorize B's principal against A's terminal session. This
    // is checked BEFORE the legacy fallback specifically to prevent that:
    // a non-empty-but-uncorrelated map fails closed rather than consulting
    // an unrelated concurrent run's legacy authority.
    const metadata = {
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'some-other-run': {
          principalId: 'someone-else',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
      lastRequestAuthority: {
        principalId: 'legacy-alice',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    };
    expect(recordedSessionAuthorityPrincipalId(metadata)).toBeUndefined();
    expect(isSessionAuthorityAuthorized(metadata, 'legacy-alice')).toBe(false);
    expect(isSessionAuthorityAuthorized(metadata, 'someone-else')).toBe(false);
  });

  it('falls back to the legacy lastRequestAuthority when lastRequestAuthorities is an empty object', () => {
    const principalId = recordedSessionAuthorityPrincipalId({
      lastRunId: 'run-1',
      lastRequestAuthorities: {},
      lastRequestAuthority: {
        principalId: 'legacy-carol',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    });
    expect(principalId).toBe('legacy-carol');
  });

  it('falls back to the legacy lastRequestAuthority when no lastRunId is recorded', () => {
    const principalId = recordedSessionAuthorityPrincipalId({
      lastRequestAuthority: {
        principalId: 'legacy-bob',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    });
    expect(principalId).toBe('legacy-bob');
  });

  it('returns undefined when the recorded authority candidate is malformed', () => {
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRunId: 'run-1',
        lastRequestAuthorities: { 'run-1': 'not-an-object' },
      }),
    ).toBeUndefined();
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRequestAuthority: ['not-an-object'],
      }),
    ).toBeUndefined();
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRunId: 'run-1',
        lastRequestAuthorities: { 'run-1': { principalId: 42 } },
      }),
    ).toBeUndefined();
  });

  it('treats a session with no recorded authority as open (every principal authorized)', () => {
    expect(isSessionAuthorityAuthorized({}, 'anyone')).toBe(true);
  });

  it('authorizes the exact recorded principal and rejects every other principal', () => {
    const metadata = {
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'run-1': {
          principalId: 'alice',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    expect(isSessionAuthorityAuthorized(metadata, 'alice')).toBe(true);
    expect(isSessionAuthorityAuthorized(metadata, 'mallory')).toBe(false);
  });

  it('fails closed (denies every principal) when the per-run authority entry is malformed, even with a valid legacy fallback available', () => {
    // Regression (Codex review): a recorded-but-malformed per-run entry must
    // NOT be conflated with "no authority recorded at all" (which
    // isSessionAuthorityAuthorized treats as open) and must NOT silently
    // fall back to a legacy field that happens to be valid — a corrupted or
    // partially-written record denies access rather than granting it.
    const metadata = {
      lastRunId: 'run-1',
      lastRequestAuthorities: {
        'run-1': { principalId: 42 },
      },
      lastRequestAuthority: {
        principalId: 'legacy-alice',
        tenantId: 'bureau',
        ownerId: 'agent',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
    };
    expect(isSessionAuthorityAuthorized(metadata, 'legacy-alice')).toBe(false);
    expect(isSessionAuthorityAuthorized(metadata, 'anyone-else')).toBe(false);
    expect(recordedSessionAuthorityPrincipalId(metadata)).toBeUndefined();
  });

  it('fails closed (denies every principal) when lastRequestAuthorities itself is a malformed container, even with no legacy fallback at all', () => {
    // Regression (Codex review, second pass): a PRESENT-but-malformed
    // lastRequestAuthorities value (an array or string, not a map) is itself
    // evidence something was recorded and corrupted — it must fail closed
    // regardless of lastRunId or a legacy field, never be read as "nothing
    // recorded" (which would authorize any principal).
    expect(
      isSessionAuthorityAuthorized(
        { lastRunId: 'run-1', lastRequestAuthorities: ['not-a-map'] },
        'anyone',
      ),
    ).toBe(false);
    expect(
      isSessionAuthorityAuthorized(
        { lastRunId: 'run-1', lastRequestAuthorities: 'not-a-map' },
        'anyone',
      ),
    ).toBe(false);
    expect(
      recordedSessionAuthorityPrincipalId({
        lastRunId: 'run-1',
        lastRequestAuthorities: ['not-a-map'],
      }),
    ).toBeUndefined();
  });

  it('fails closed (denies every principal) when a non-empty lastRequestAuthorities map cannot be correlated to lastRunId and no legacy fallback exists', () => {
    // Regression (Codex review, third pass): a valid, NON-EMPTY
    // lastRequestAuthorities map that simply doesn't name an entry for this
    // lastRunId (missing/corrupt lastRunId, or entries keyed to other runs)
    // is recorded-but-uncorrelated evidence, not "nothing recorded" — it
    // must fail closed too, when there is no legacy field to fall back to.
    const metadataMissingLastRunId = {
      lastRequestAuthorities: {
        'some-run': {
          principalId: 'someone',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    expect(isSessionAuthorityAuthorized(metadataMissingLastRunId, 'anyone')).toBe(false);
    expect(recordedSessionAuthorityPrincipalId(metadataMissingLastRunId)).toBeUndefined();

    const metadataUncorrelatedLastRunId = {
      lastRunId: 'run-not-in-map',
      lastRequestAuthorities: {
        'some-other-run': {
          principalId: 'someone',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    expect(isSessionAuthorityAuthorized(metadataUncorrelatedLastRunId, 'anyone')).toBe(false);
  });

  it("authorizes against an explicitly targeted run's own entry, not lastRunId, when a different concurrent run's more recent terminal transition left the map uncorrelated to lastRunId (PR #430 review, Codex P2, second wave — 'Authorize against the targeted live run')", () => {
    // Two concurrent runs, A (still live) and B (completed first). B's own
    // terminal transition prunes ONLY lastRequestAuthorities[B] (per this
    // file's own pruning rule near `remainingAuthorities`), leaving
    // lastRunId: 'run-b' and A's now-uncorrelated 'run-a' entry behind —
    // exactly the shape the previous test proves fails closed for EVERY
    // principal under the default (lastRunId-only) lookup.
    const metadata = {
      lastRunId: 'run-b',
      lastRequestAuthorities: {
        'run-a': {
          principalId: 'alice',
          tenantId: 'bureau',
          ownerId: 'agent',
          capabilities: ['tools:execute'],
          authorizationRevision: 'bureau:1',
        },
      },
    };
    // The default (no targetRunId) lookup still fails closed — unchanged.
    expect(isSessionAuthorityAuthorized(metadata, 'alice')).toBe(false);

    // A command explicitly targeting the still-live run A resolves against
    // A's own entry directly, authorizing alice and rejecting anyone else.
    expect(isSessionAuthorityAuthorized(metadata, 'alice', 'run-a')).toBe(true);
    expect(isSessionAuthorityAuthorized(metadata, 'mallory', 'run-a')).toBe(false);

    // Targeting a run with no entry of its own at all still fails closed —
    // this is defense against authorizing a run this map says nothing
    // about, not a general bypass of the uncorrelated-map rule.
    expect(isSessionAuthorityAuthorized(metadata, 'alice', 'run-c')).toBe(false);
  });
});

describe('resolvePersistedRunOwningPrincipal (AB-359)', () => {
  it('returns undefined when the map is entirely absent — the exact shape an older, pre-AB-359 record decodes as', () => {
    expect(resolvePersistedRunOwningPrincipal({}, 'run-1')).toBeUndefined();
  });

  it('returns undefined when the map does not carry an entry for this runId', () => {
    expect(
      resolvePersistedRunOwningPrincipal(
        { lastRunOwningPrincipals: { 'run-other': 'alice' } },
        'run-1',
      ),
    ).toBeUndefined();
  });

  it('returns undefined when the map itself is malformed (not a plain object)', () => {
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: ['not-a-map'] }, 'run-1'),
    ).toBeUndefined();
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: 'not-a-map' }, 'run-1'),
    ).toBeUndefined();
  });

  it('returns undefined when the entry for this runId is present but not a string', () => {
    expect(
      resolvePersistedRunOwningPrincipal({ lastRunOwningPrincipals: { 'run-1': 42 } }, 'run-1'),
    ).toBeUndefined();
  });

  it('returns the persisted principal for a well-formed entry', () => {
    expect(
      resolvePersistedRunOwningPrincipal(
        { lastRunOwningPrincipals: { 'run-1': 'alice', 'run-2': 'bob' } },
        'run-1',
      ),
    ).toBe('alice');
  });
});

describe('isSessionRunTerminal (AB-194)', () => {
  it('is false when lastRunStatus is running', () => {
    expect(isSessionRunTerminal({ lastRunStatus: 'running' })).toBe(false);
  });

  it('is true for every non-running status, including absent', () => {
    expect(isSessionRunTerminal({ lastRunStatus: 'completed' })).toBe(true);
    expect(isSessionRunTerminal({ lastRunStatus: 'error' })).toBe(true);
    expect(isSessionRunTerminal({ lastRunStatus: 'aborted' })).toBe(true);
    expect(isSessionRunTerminal({})).toBe(true);
  });
});
