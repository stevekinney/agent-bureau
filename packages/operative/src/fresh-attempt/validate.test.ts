import { describe, expect, it } from 'bun:test';

import type { ContextSourceRecord } from '../context-epoch';
import { digestText } from '../context-epoch';
import { AgentRunError, agentRunErrorToJSON, serializeAgentRunError } from '../errors';
import type { FreshAttemptRejectionOutcome } from './errors';
import {
  CorruptFreshAttemptArtifactError,
  FreshAttemptArtifactError,
  IncompatibleFreshAttemptArtifactError,
  InvalidFreshAttemptArtifactError,
  OverbroadFreshAttemptArtifactError,
  OversizedFreshAttemptArtifactError,
  ProvenanceFreeFreshAttemptArtifactError,
  SecretBearingFreshAttemptArtifactError,
  StaleFreshAttemptArtifactError,
  UnauthorizedFreshAttemptArtifactError,
} from './errors';
import {
  FIXTURE_ACTOR,
  FIXTURE_NOW,
  createFixtureArtifact,
  createFixtureEpoch,
  createFixtureSource,
  resolverFor,
} from './fixtures/artifact-fixture';
import type { FreshAttemptHandoffArtifact } from './handoff-artifact';
import {
  FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS,
  FRESH_ATTEMPT_ARTIFACT_MAX_BYTES,
  FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES,
  FRESH_ATTEMPT_ARTIFACT_RETENTION_MS,
} from './thresholds';
import type { FreshAttemptValidationContext } from './validate';
import {
  validateFreshAttemptArtifact,
  validateFreshAttemptArtifactForPublication,
} from './validate';

const REQUIRED_FIELDS = [
  'schemaVersion',
  'artifactId',
  'objective',
  'successRevision',
  'constraints',
  'completedWork',
  'validatedFacts',
  'evidenceReferences',
  'knownFailures',
  'unresolvedQuestions',
  'nextRequestedAction',
  'allowedCarryForwardContext',
  'producer',
  'sourceRunOrAttempt',
  'timestamp',
  'lineage',
  'provenance',
  'digest',
  'revision',
] as const;

const PROVENANCE_FIELDS = new Set(['producer', 'provenance', 'sourceRunOrAttempt', 'timestamp']);

/** Far enough ahead that no clock this suite sets ever reaches it. */
const FAR_FUTURE = '9999-01-01T00:00:00.000Z';

function context(overrides: Partial<FreshAttemptValidationContext> = {}) {
  return { resolveSource: resolverFor(createFixtureSource()), now: FIXTURE_NOW, ...overrides };
}

async function rejectionOf(pending: Promise<unknown>): Promise<FreshAttemptArtifactError> {
  const outcome = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof FreshAttemptArtifactError)) {
    throw new TypeError(`Expected a FreshAttemptArtifactError, got ${String(outcome)}`);
  }
  return outcome;
}

function without(artifact: FreshAttemptHandoffArtifact, field: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...artifact };
  delete copy[field];
  return copy;
}

describe('validateFreshAttemptArtifact', () => {
  it('returns the parsed artifact and its resolved source for a valid artifact', async () => {
    const artifact = await createFixtureArtifact();
    const source = createFixtureSource();

    const validated = await validateFreshAttemptArtifact(
      artifact,
      context({
        resolveSource: resolverFor(source),
      }),
    );

    expect(validated.artifact).toEqual(artifact);
    expect(validated.source).toBe(source);
    expect(validated.carryForward.map((record) => record.sourceId)).toEqual([
      'agent-instructions',
      'toolbox',
    ]);
  });

  it.each(REQUIRED_FIELDS.map((field) => [field]))(
    'rejects an artifact missing %s with a contract-kind error naming that path',
    async (field) => {
      const artifact = await createFixtureArtifact();

      const error = await rejectionOf(
        validateFreshAttemptArtifact(without(artifact, field), context()),
      );

      expect(error).toBeInstanceOf(AgentRunError);
      expect(error.kind).toBe('contract');
      expect(error.diagnostics).toContainEqual({ path: field, rule: 'required' });
      expect(error.message).toContain(field);
      expect(error).toBeInstanceOf(
        PROVENANCE_FIELDS.has(field)
          ? ProvenanceFreeFreshAttemptArtifactError
          : InvalidFreshAttemptArtifactError,
      );
    },
  );

  it('treats a missing nested provenance member as provenance-free', async () => {
    const artifact = await createFixtureArtifact();
    const candidate = { ...artifact, provenance: { producedAt: artifact.provenance.producedAt } };

    const error = await rejectionOf(validateFreshAttemptArtifact(candidate, context()));

    expect(error).toBeInstanceOf(ProvenanceFreeFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'provenance.producingActor', rule: 'required' }]);
  });

  it('rejects an fnv1a-64 digest as invalid and accepts the correct sha-256 digest', async () => {
    const artifact = await createFixtureArtifact();
    const fnv = { ...artifact, digest: { algorithm: 'fnv1a-64', value: artifact.digest.value } };

    const error = await rejectionOf(validateFreshAttemptArtifact(fnv, context()));

    expect(error).toBeInstanceOf(InvalidFreshAttemptArtifactError);
    expect(error.kind).toBe('contract');
    expect(error.diagnostics).toEqual([{ path: 'digest.algorithm', rule: 'invalid_value' }]);
    expect(await validateFreshAttemptArtifact(artifact, context())).toBeDefined();
  });

  it('rejects a single mutated field under an unchanged digest as corrupt', async () => {
    const artifact = await createFixtureArtifact();
    const mutated = { ...artifact, objective: `${artifact.objective} (edited)` };

    const error = await rejectionOf(validateFreshAttemptArtifact(mutated, context()));

    expect(error).toBeInstanceOf(CorruptFreshAttemptArtifactError);
    expect(error.kind).toBe('load');
    expect(error.diagnostics).toEqual([{ path: 'digest.value', rule: 'digest-mismatch' }]);
  });

  it('rejects a value that is not an object as invalid', async () => {
    const error = await rejectionOf(validateFreshAttemptArtifact('artifact', context()));

    expect(error).toBeInstanceOf(InvalidFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: '', rule: 'not-an-object' }]);
    expect(error.message).toContain('<artifact>');
  });

  it('names each undeclared key rather than its value', async () => {
    const artifact = await createFixtureArtifact();
    const candidate = { ...artifact, lineage: { ...artifact.lineage, notes: 'hunter2' } };

    const error = await rejectionOf(validateFreshAttemptArtifact(candidate, context()));

    expect(error).toBeInstanceOf(InvalidFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'lineage.notes', rule: 'unrecognized_keys' }]);
    expect(error.message).not.toContain('hunter2');
  });

  it('reports a wrongly typed array element by its index path', async () => {
    const artifact = await createFixtureArtifact();
    const candidate = { ...artifact, constraints: ['Keep it green.', 42] };

    const error = await rejectionOf(validateFreshAttemptArtifact(candidate, context()));

    expect(error.diagnostics).toEqual([{ path: 'constraints[1]', rule: 'invalid_type' }]);
  });

  it('terminates on a cyclic value and reports it as invalid', async () => {
    const artifact = await createFixtureArtifact();
    const lineage: Record<string, unknown> = { ...artifact.lineage };
    lineage['self'] = lineage;

    const error = await rejectionOf(
      validateFreshAttemptArtifact({ ...artifact, lineage }, context()),
    );

    expect(error).toBeInstanceOf(InvalidFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'lineage.self', rule: 'unrecognized_keys' }]);
  });

  it('checks schema, digest, staleness, then authorization, in that order', async () => {
    const artifact = await createFixtureArtifact();
    const late = { now: FIXTURE_NOW + FRESH_ATTEMPT_ARTIFACT_RETENTION_MS };
    const unresolved = { resolveSource: () => undefined };

    // Schema before digest: an invalid body with a stale digest is invalid, not corrupt.
    const invalidAndCorrupt = { ...artifact, objective: '' };
    expect(
      await rejectionOf(validateFreshAttemptArtifact(invalidAndCorrupt, context(late))),
    ).toBeInstanceOf(InvalidFreshAttemptArtifactError);

    // Digest before staleness.
    const corruptAndStale = { ...artifact, objective: 'Edited.' };
    expect(
      await rejectionOf(validateFreshAttemptArtifact(corruptAndStale, context(late))),
    ).toBeInstanceOf(CorruptFreshAttemptArtifactError);

    // Staleness before authorization.
    expect(
      await rejectionOf(
        validateFreshAttemptArtifact(artifact, context({ ...late, ...unresolved })),
      ),
    ).toBeInstanceOf(StaleFreshAttemptArtifactError);

    // A future timestamp is a staleness failure, so it precedes authorization too.
    const future = await createFixtureArtifact({ timestamp: FAR_FUTURE });
    expect(
      await rejectionOf(validateFreshAttemptArtifact(future, context(unresolved))),
    ).toBeInstanceOf(StaleFreshAttemptArtifactError);
  });
});

describe('staleness and retention', () => {
  it('accepts an artifact on the last instant of its retention window', async () => {
    const artifact = await createFixtureArtifact();
    const now = Date.parse(artifact.timestamp) + FRESH_ATTEMPT_ARTIFACT_RETENTION_MS;

    expect(await validateFreshAttemptArtifact(artifact, context({ now }))).toBeDefined();
  });

  it('rejects an artifact past its retention window as stale', async () => {
    const artifact = await createFixtureArtifact();
    const now = Date.parse(artifact.timestamp) + FRESH_ATTEMPT_ARTIFACT_RETENTION_MS + 1;

    const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context({ now })));

    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(error.kind).toBe('load');
    expect(error.diagnostics).toEqual([{ path: 'timestamp', rule: 'retention-window' }]);
  });

  it('does not apply retention when checking an artifact for publication', async () => {
    const artifact = await createFixtureArtifact({ timestamp: '2020-01-01T00:00:00.000Z' });

    expect(await validateFreshAttemptArtifactForPublication(artifact, context())).toBeDefined();
  });

  it('rejects a timestamp after now as stale however far the clock moves', async () => {
    const artifact = await createFixtureArtifact({ timestamp: FAR_FUTURE });

    for (const now of [FIXTURE_NOW, FIXTURE_NOW + 100 * FRESH_ATTEMPT_ARTIFACT_RETENTION_MS]) {
      const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context({ now })));

      expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
      expect(error.kind).toBe('load');
      expect(error.diagnostics).toEqual([{ path: 'timestamp', rule: 'timestamp-in-future' }]);
    }
  });

  it('rejects a provenance.producedAt after now as stale', async () => {
    const artifact = await createFixtureArtifact({
      provenance: { producedAt: FAR_FUTURE, producingActor: FIXTURE_ACTOR },
    });

    const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context()));

    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([
      { path: 'provenance.producedAt', rule: 'timestamp-in-future' },
    ]);
  });

  it('tolerates a timestamp ahead of now by the clock-skew allowance and no more', async () => {
    const artifact = await createFixtureArtifact();
    const earliest = Date.parse(artifact.timestamp) - FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS;

    expect(await validateFreshAttemptArtifact(artifact, context({ now: earliest }))).toBeDefined();
    const error = await rejectionOf(
      validateFreshAttemptArtifact(artifact, context({ now: earliest - 1 })),
    );
    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([
      { path: 'timestamp', rule: 'timestamp-in-future' },
      { path: 'provenance.producedAt', rule: 'timestamp-in-future' },
    ]);
  });

  it('rejects a timestamp after now when checking an artifact for publication', async () => {
    const artifact = await createFixtureArtifact({ timestamp: FAR_FUTURE });

    const error = await rejectionOf(
      validateFreshAttemptArtifactForPublication(artifact, context()),
    );

    expect(error).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'timestamp', rule: 'timestamp-in-future' }]);
  });
});

describe('authorization', () => {
  it('rejects an artifact whose source run cannot be resolved', async () => {
    const artifact = await createFixtureArtifact();

    const error = await rejectionOf(
      validateFreshAttemptArtifact(artifact, context({ resolveSource: async () => undefined })),
    );

    expect(error).toBeInstanceOf(UnauthorizedFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([{ path: 'sourceRunOrAttempt', rule: 'source-unresolved' }]);
  });

  it('resolves the source for the artifact’s own sourceRunOrAttempt', async () => {
    const artifact = await createFixtureArtifact();
    const requested: unknown[] = [];

    await validateFreshAttemptArtifact(
      artifact,
      context({
        resolveSource: (source) => {
          requested.push(source);
          return createFixtureSource();
        },
      }),
    );

    expect(requested).toEqual([artifact.sourceRunOrAttempt]);
  });

  it('rejects an actor the source does not permit', async () => {
    const artifact = await createFixtureArtifact({
      provenance: { producedAt: '2026-09-26T18:00:00.000Z', producingActor: 'agent:unknown' },
    });

    const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context()));

    expect(error).toBeInstanceOf(UnauthorizedFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([
      { path: 'provenance.producingActor', rule: 'actor-not-permitted' },
    ]);
  });

  it('rejects a producer that is not the source run', async () => {
    const artifact = await createFixtureArtifact({
      producer: { agentName: 'implementer', runId: 'other:3', sessionId: 'other' },
    });

    const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context()));

    expect(error).toBeInstanceOf(UnauthorizedFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([
      { path: 'producer.sessionId', rule: 'producer-source-mismatch' },
      { path: 'producer.runId', rule: 'producer-source-mismatch' },
    ]);
  });
});

describe('secret-bearing', () => {
  async function expectSecretBearing(
    candidate: unknown,
    expected: { path: string; rule: string },
    secret: string,
  ): Promise<void> {
    const error = await rejectionOf(validateFreshAttemptArtifact(candidate, context()));

    expect(error).toBeInstanceOf(SecretBearingFreshAttemptArtifactError);
    expect(error.kind).toBe('policy');
    expect(error.diagnostics).toEqual([expected]);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.diagnostics)).not.toContain(secret);
    expect(serializeAgentRunError(error)).not.toContain(secret);
  }

  describe('structural leg', () => {
    it('rejects a Message-shaped object smuggled into a field', async () => {
      const artifact = await createFixtureArtifact();
      const secret = 'I pasted the whole transcript here';
      const message = { id: 'm1', role: 'assistant', content: secret };

      await expectSecretBearing(
        { ...artifact, completedWork: [message] },
        { path: 'completedWork[0]', rule: 'transcript-role-key' },
        secret,
      );
    });

    it('rejects a serialized Message inside a string field', async () => {
      const secret = 'Here is the fix I tried before';
      const artifact = await createFixtureArtifact({
        completedWork: [`{"role": "assistant", "content": "${secret}"}`],
      });

      await expectSecretBearing(
        artifact,
        { path: 'completedWork[0]', rule: 'transcript-role-key' },
        secret,
      );
    });

    it('rejects a raw tool payload object', async () => {
      const artifact = await createFixtureArtifact();
      const secret = 'raw tool output body';
      const candidate = {
        ...artifact,
        evidenceReferences: [{ kind: 'tool', id: 't1', toolResult: { content: secret } }],
      };

      await expectSecretBearing(
        candidate,
        { path: 'evidenceReferences[0]', rule: 'transcript-tool-payload' },
        secret,
      );
    });

    it('rejects a serialized tool payload inside a string field', async () => {
      const secret = 'stdout of the failed command';
      const artifact = await createFixtureArtifact({
        validatedFacts: [`{"type":"tool_result","content":"${secret}"}`],
      });

      await expectSecretBearing(
        artifact,
        { path: 'validatedFacts[0]', rule: 'transcript-tool-payload' },
        secret,
      );
    });

    it('rejects a ConversationHistory-shaped object', async () => {
      const artifact = await createFixtureArtifact();
      const secret = 'history message body';
      const candidate = { ...artifact, objective: { ids: ['m1'], messages: { m1: secret } } };

      await expectSecretBearing(
        candidate,
        { path: 'objective', rule: 'conversation-history-shape' },
        secret,
      );
    });
  });

  describe('pattern leg', () => {
    it('rejects a sensitive key named in a key: value pair (SENSITIVE_KEY_PATTERN)', async () => {
      const secret = 'correct horse battery staple';
      const artifact = await createFixtureArtifact({
        unresolvedQuestions: [`Should the fixture keep password: ${secret}?`],
      });

      await expectSecretBearing(
        artifact,
        { path: 'unresolvedQuestions[0]', rule: 'sensitive-key-pattern' },
        secret,
      );
    });

    it('rejects a key=value credential (PII_RULES.apiKey)', async () => {
      const secret = 'hunter2hunter2hunter2';
      const artifact = await createFixtureArtifact({
        knownFailures: [
          {
            kind: 'tool',
            summary: `Deploy failed with deploy_key=${secret}`,
            occurredAt: '2026-09-26T17:40:00.000Z',
          },
        ],
      });

      await expectSecretBearing(
        artifact,
        { path: 'knownFailures[0].summary', rule: 'pii-api-key' },
        secret,
      );
    });

    it('scans evidence URIs', async () => {
      const secret = 'q1w2e3r4t5y6u7i8o9p0';
      const artifact = await createFixtureArtifact({
        evidenceReferences: [
          { kind: 'log', id: 'l1', uri: `https://logs.test/run?token=${secret}` },
        ],
      });

      await expectSecretBearing(
        artifact,
        { path: 'evidenceReferences[0].uri', rule: 'sensitive-key-pattern' },
        secret,
      );
    });

    it('does not reject prose that only mentions a sensitive word', async () => {
      const artifact = await createFixtureArtifact({
        completedWork: ['Added token counting to the compactor and fixed the authorization check.'],
      });

      expect(await validateFreshAttemptArtifact(artifact, context())).toBeDefined();
    });
  });

  describe('epoch-digest collision leg', () => {
    const fragment = 'You are the release manager. Never describe the signing procedure.';

    function protectedSource(overrides: Partial<ContextSourceRecord>): ContextSourceRecord {
      return {
        sourceId: 'release-prompt',
        trust: 'protected-secret',
        precedence: 0,
        availability: 'required',
        redaction: 'digest-only',
        disposition: { kind: 'included' },
        digest: digestText(fragment),
        ...overrides,
      };
    }

    it.each([
      ['protected-secret trust', protectedSource({})],
      [
        'forbidden redaction',
        protectedSource({ trust: 'trusted-operator', redaction: 'forbidden' }),
      ],
    ])('rejects a verbatim reproduction of a %s source', async (_label, record) => {
      const artifact = await createFixtureArtifact({ validatedFacts: [fragment] });
      const source = createFixtureSource(createFixtureEpoch([record]));

      const error = await rejectionOf(
        validateFreshAttemptArtifact(artifact, context({ resolveSource: resolverFor(source) })),
      );

      expect(error).toBeInstanceOf(SecretBearingFreshAttemptArtifactError);
      expect(error.diagnostics).toEqual([
        { path: 'validatedFacts[0]', rule: 'protected-source-digest' },
      ]);
      expect(error.message).not.toContain(fragment);
    });

    it('ignores a protected source that recorded no digest', async () => {
      const artifact = await createFixtureArtifact({ validatedFacts: [fragment] });
      const source = createFixtureSource(
        createFixtureEpoch([protectedSource({ digest: undefined })]),
      );

      expect(
        await validateFreshAttemptArtifact(
          artifact,
          context({ resolveSource: resolverFor(source) }),
        ),
      ).toBeDefined();
    });
  });

  describe('entropy leg', () => {
    it('rejects a bare high-entropy token with no key prefix', async () => {
      const secret = 'Kq8vZ3xN7mR2pL9wT4bY6cH1jF5dS0gAuEiOeWzU';
      const artifact = await createFixtureArtifact({
        nextRequestedAction: `Retry the upload with ${secret} as the bearer value.`,
      });

      await expectSecretBearing(
        artifact,
        { path: 'nextRequestedAction', rule: 'high-entropy-token' },
        secret,
      );
    });

    it('does not reject a sha-256 hex digest', async () => {
      const artifact = await createFixtureArtifact({
        validatedFacts: [`Baseline digest ${'0123456789abcdef'.repeat(4)} is unchanged.`],
      });

      expect(await validateFreshAttemptArtifact(artifact, context())).toBeDefined();
    });
  });
});

describe('overbroad', () => {
  it('rejects an allowlist entry absent from the producing run’s sealed epoch', async () => {
    const artifact = await createFixtureArtifact({
      allowedCarryForwardContext: ['toolbox', 'conversation-transcript'],
    });

    const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context()));

    expect(error).toBeInstanceOf(OverbroadFreshAttemptArtifactError);
    expect(error.kind).toBe('contract');
    expect(error.diagnostics).toEqual([
      { path: 'allowedCarryForwardContext[1]', rule: 'source-absent-from-epoch' },
    ]);
  });

  it.each([
    ['protected-secret', { trust: 'protected-secret' as const, redaction: 'digest-only' as const }],
    ['forbidden', { trust: 'trusted-operator' as const, redaction: 'forbidden' as const }],
  ])('rejects an allowlist entry the epoch marks %s', async (_label, marking) => {
    const record: ContextSourceRecord = {
      sourceId: 'vault',
      precedence: 0,
      availability: 'optional',
      disposition: { kind: 'included' },
      ...marking,
    };
    const source = createFixtureSource(createFixtureEpoch([record]));
    const artifact = await createFixtureArtifact({ allowedCarryForwardContext: ['vault'] });

    const error = await rejectionOf(
      validateFreshAttemptArtifact(artifact, context({ resolveSource: resolverFor(source) })),
    );

    expect(error).toBeInstanceOf(OverbroadFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([
      { path: 'allowedCarryForwardContext[0]', rule: 'source-not-carriable' },
    ]);
  });

  it('rejects an allowlist longer than its bounded count', async () => {
    const artifact = await createFixtureArtifact({
      allowedCarryForwardContext: Array.from(
        { length: FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES + 1 },
        () => 'toolbox',
      ),
    });

    const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context()));

    expect(error).toBeInstanceOf(OverbroadFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([
      { path: 'allowedCarryForwardContext', rule: 'exceeds-bounded-count' },
    ]);
  });
});

describe('the nine rejection outcomes', () => {
  async function oversized(): Promise<FreshAttemptHandoffArtifact> {
    const entries = Math.ceil(FRESH_ATTEMPT_ARTIFACT_MAX_BYTES / 20) + 1;
    return createFixtureArtifact({
      completedWork: Array.from({ length: entries }, (_, index) => `Finished step ${index}.`),
    });
  }

  const cases: [
    FreshAttemptRejectionOutcome,
    new (...parameters: never[]) => FreshAttemptArtifactError,
    'contract' | 'load' | 'policy',
    () => Promise<{ value: unknown; context?: Partial<FreshAttemptValidationContext> }>,
  ][] = [
    [
      'invalid',
      InvalidFreshAttemptArtifactError,
      'contract',
      async () => ({ value: { ...(await createFixtureArtifact()), revision: 0 } }),
    ],
    [
      'stale',
      StaleFreshAttemptArtifactError,
      'load',
      async () => ({
        value: await createFixtureArtifact(),
        context: { now: FIXTURE_NOW + FRESH_ATTEMPT_ARTIFACT_RETENTION_MS },
      }),
    ],
    [
      'incompatible',
      IncompatibleFreshAttemptArtifactError,
      'contract',
      async () => ({ value: { ...(await createFixtureArtifact()), schemaVersion: 2 } }),
    ],
    [
      'oversized',
      OversizedFreshAttemptArtifactError,
      'contract',
      async () => ({ value: await oversized() }),
    ],
    [
      'secret-bearing',
      SecretBearingFreshAttemptArtifactError,
      'policy',
      async () => ({ value: await createFixtureArtifact({ objective: 'Rotate api_key: abc123' }) }),
    ],
    [
      'unauthorized',
      UnauthorizedFreshAttemptArtifactError,
      'policy',
      async () => ({
        value: await createFixtureArtifact(),
        context: { resolveSource: () => undefined },
      }),
    ],
    [
      'overbroad',
      OverbroadFreshAttemptArtifactError,
      'contract',
      async () => ({
        value: await createFixtureArtifact({ allowedCarryForwardContext: ['nope'] }),
      }),
    ],
    [
      'provenance-free',
      ProvenanceFreeFreshAttemptArtifactError,
      'contract',
      async () => ({ value: without(await createFixtureArtifact(), 'provenance') }),
    ],
    [
      'corrupt',
      CorruptFreshAttemptArtifactError,
      'load',
      async () => ({ value: { ...(await createFixtureArtifact()), revision: 2 } }),
    ],
  ];

  it('covers exactly the nine outcomes COR-894 names', () => {
    expect(cases.map(([outcome]) => outcome)).toEqual([
      'invalid',
      'stale',
      'incompatible',
      'oversized',
      'secret-bearing',
      'unauthorized',
      'overbroad',
      'provenance-free',
      'corrupt',
    ]);
  });

  it.each(cases)(
    '%s rejects with its own error class and COR-843 kind',
    async (outcome, ErrorClass, kind, build) => {
      const { value, context: overrides } = await build();

      const error = await rejectionOf(validateFreshAttemptArtifact(value, context(overrides)));

      expect(error).toBeInstanceOf(ErrorClass);
      expect(error).toBeInstanceOf(AgentRunError);
      expect(error.outcome).toBe(outcome);
      expect(error.kind).toBe(kind);
      expect(error.name).toBe(ErrorClass.name);
      // `AgentRunErrorCode` is mirrored by Chat's wire contract (COR-248), so
      // admitting a new code is a components/chat decision. A rejection is
      // identified on the wire by its class name and kind under `UNKNOWN`.
      expect(agentRunErrorToJSON(error)).toEqual({
        name: ErrorClass.name,
        message: error.message,
        kind,
        code: 'UNKNOWN',
      });
    },
  );

  it('reports the incompatible schema version without dual-reading the body', async () => {
    const artifact = { ...(await createFixtureArtifact()), schemaVersion: 2, objective: 42 };

    const error = await rejectionOf(validateFreshAttemptArtifact(artifact, context()));

    expect(error).toBeInstanceOf(IncompatibleFreshAttemptArtifactError);
    expect(error.diagnostics).toEqual([
      { path: 'schemaVersion', rule: 'unsupported-schema-version' },
    ]);
  });

  it('measures the byte ceiling over the canonical serialization', async () => {
    const error = await rejectionOf(validateFreshAttemptArtifact(await oversized(), context()));

    expect(error.diagnostics).toEqual([{ path: '', rule: 'exceeds-byte-ceiling' }]);
  });
});
