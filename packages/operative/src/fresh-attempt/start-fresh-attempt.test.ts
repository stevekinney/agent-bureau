import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { createSessionStore } from '../session/create-session-store';
import { createSessionHandle } from '../session/session-handle';
import {
  createInstantGenerate,
  createTestRunOptions,
} from '../session/session-handle-test-support';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  SecretBearingFreshAttemptArtifactError,
  StaleFreshAttemptArtifactError,
  UnauthorizedFreshAttemptArtifactError,
} from './errors';
import {
  FIXTURE_NOW,
  createFixtureArtifact,
  createFixtureSource,
  resolverFor,
} from './fixtures/artifact-fixture';
import type { FreshAttemptHandoffArtifact } from './handoff-artifact';
import { FRESH_ATTEMPT_ARTIFACT_RETENTION_MS } from './thresholds';
import type { FreshAttemptSourceResolver } from './validate';

afterEach(async () => {
  await yieldToPortableEventLoop();
});

function textOf(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

const INSTRUCTIONS = 'You are the implementer. Follow AGENTS.md. Use test-driven development.';

function createSourceFixture(
  options: { resolveFreshAttemptSource?: FreshAttemptSourceResolver } = {},
) {
  const runtime = createManualRuntimeServices({ origin: new Date(FIXTURE_NOW).toISOString() });
  const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
  const handle = createSessionHandle('session-fixture', {
    store,
    agentName: 'implementer',
    runOptions: createTestRunOptions(
      createInstantGenerate('I tried and the test still timed out.'),
    ),
    runtime,
    ...options,
  });
  return { handle, store, runtime };
}

/** An artifact whose every required field carries a value no other field shares. */
function distinctArtifact(): Promise<FreshAttemptHandoffArtifact> {
  return createFixtureArtifact({
    artifactId: 'artifact-id-marker',
    revision: 3,
    objective: 'objective-marker',
    successRevision: 'success-revision-marker',
    constraints: ['constraint-marker'],
    completedWork: ['completed-work-marker'],
    validatedFacts: ['validated-fact-marker'],
    evidenceReferences: [{ kind: 'evidence-kind-marker', id: 'evidence-id-marker' }],
    knownFailures: [
      { kind: 'generate', summary: 'known-failure-marker', occurredAt: '2026-09-26T17:41:00.000Z' },
    ],
    unresolvedQuestions: ['unresolved-question-marker'],
    nextRequestedAction: 'next-action-marker',
    allowedCarryForwardContext: ['toolbox'],
    lineage: { parentConversationId: 'parent-conversation-marker', sourceRevision: 11 },
    provenance: { producedAt: '2026-09-26T17:59:00.000Z', producingActor: 'operator:steve-kinney' },
  });
}

describe('SessionHandle.startFreshAttempt()', () => {
  it('starts a new session with no runs and no message shared with the source', async () => {
    const { handle } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    await handle.run('Fix the flaky revision-realm test.').result();
    await yieldToPortableEventLoop();
    const source = await handle.getSession();
    expect(source.conversationHistory.ids.length).toBeGreaterThan(0);

    const fresh = await handle.startFreshAttempt({
      artifact: await distinctArtifact(),
      instructions: INSTRUCTIONS,
    });
    const session = await fresh.getSession();

    expect(fresh.id).not.toBe(handle.id);
    expect(session.id).toBe(fresh.id);
    expect(session.runs).toEqual([]);
    const sourceIds = new Set(source.conversationHistory.ids);
    expect(session.conversationHistory.ids.filter((id) => sourceIds.has(id))).toEqual([]);
    const sourceContent = new Set(
      Object.values(source.conversationHistory.messages).map((message) => message.content),
    );
    expect(
      Object.values(session.conversationHistory.messages).filter((message) =>
        sourceContent.has(message.content),
      ),
    ).toEqual([]);
  });

  it('seeds only the approved instructions and one rendering of the artifact', async () => {
    const { handle } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const artifact = await distinctArtifact();

    const fresh = await handle.startFreshAttempt({ artifact, instructions: INSTRUCTIONS });
    const { conversationHistory } = await fresh.getSession();
    const messages = conversationHistory.ids.map((id) => conversationHistory.messages[id]);

    expect(messages.map((message) => message?.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(INSTRUCTIONS);
    expect(messages[1]?.metadata).toEqual({
      freshAttemptArtifactId: 'artifact-id-marker',
      freshAttemptArtifactRevision: 3,
    });
  });

  it('renders every required artifact field into the seed', async () => {
    const { handle } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const artifact = await distinctArtifact();

    const fresh = await handle.startFreshAttempt({ artifact, instructions: INSTRUCTIONS });
    const { conversationHistory } = await fresh.getSession();
    const seed = Object.values(conversationHistory.messages)
      .map((message) => textOf(message.content))
      .join('\n');

    const rendered: Record<keyof FreshAttemptHandoffArtifact, readonly string[]> = {
      schemaVersion: ['schemaVersion: 1'],
      artifactId: ['artifactId: artifact-id-marker'],
      revision: ['revision: 3'],
      objective: ['objective: objective-marker'],
      successRevision: ['successRevision: success-revision-marker'],
      constraints: ['constraints:', '- constraint-marker'],
      completedWork: ['completedWork:', '- completed-work-marker'],
      validatedFacts: ['validatedFacts:', '- validated-fact-marker'],
      evidenceReferences: ['evidenceReferences:', 'evidence-kind-marker evidence-id-marker'],
      knownFailures: ['knownFailures:', '[generate] 2026-09-26T17:41:00.000Z known-failure-marker'],
      unresolvedQuestions: ['unresolvedQuestions:', '- unresolved-question-marker'],
      nextRequestedAction: ['nextRequestedAction: next-action-marker'],
      allowedCarryForwardContext: [
        'allowedCarryForwardContext:',
        '- toolbox (trust trusted-operator',
      ],
      producer: ['producer: agent implementer, run session-fixture:0, session session-fixture'],
      sourceRunOrAttempt: [
        'sourceRunOrAttempt: session session-fixture, run session-fixture:0, sequence 0',
      ],
      timestamp: [`timestamp: ${artifact.timestamp}`],
      lineage: ['lineage: sourceRevision 11, parentConversationId parent-conversation-marker'],
      provenance: [
        'provenance: producingActor operator:steve-kinney, producedAt 2026-09-26T17:59:00.000Z',
      ],
      digest: [`digest: sha-256 ${artifact.digest.value}`],
    };
    for (const [field, fragments] of Object.entries(rendered)) {
      for (const fragment of fragments) {
        expect({ field, rendered: seed.includes(fragment) }).toEqual({ field, rendered: true });
      }
    }
  });

  it('renders empty lists and optional members explicitly', async () => {
    const { handle } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const artifact = await createFixtureArtifact({
      constraints: [],
      evidenceReferences: [
        { kind: 'commit', id: '55a9f8d2', digest: 'b'.repeat(64), uri: 'git:55a9f8d2' },
      ],
      allowedCarryForwardContext: ['conversation', 'hook-plan'],
      lineage: { sourceRevision: 4 },
    });

    const fresh = await handle.startFreshAttempt({ artifact, instructions: INSTRUCTIONS });
    const { conversationHistory } = await fresh.getSession();
    const seed = Object.values(conversationHistory.messages)
      .map((message) => textOf(message.content))
      .join('\n');

    expect(seed).toContain('constraints: (none)');
    expect(seed).toContain(`- commit 55a9f8d2, digest ${'b'.repeat(64)}, uri git:55a9f8d2`);
    expect(seed).toContain('lineage: sourceRevision 4\n');
    expect(seed).toMatch(
      /- conversation \(trust per-message, redaction reference-only, revision 1, digest operator=1/,
    );
    expect(seed).toContain(
      '- hook-plan (trust trusted-operator, redaction digest-only, revision 3)',
    );
  });

  it('rejects an invalid artifact before constructing or persisting anything', async () => {
    const { handle, store, runtime } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const save = spyOn(store, 'save');
    const mint = spyOn(runtime.identifiers, 'next');
    const artifact = await createFixtureArtifact({ objective: 'Retry with password: swordfish' });

    const pending = handle.startFreshAttempt({ artifact, instructions: INSTRUCTIONS });

    expect(await rejectionOf(pending)).toBeInstanceOf(SecretBearingFreshAttemptArtifactError);
    expect(save).not.toHaveBeenCalled();
    expect(mint.mock.calls.filter(([kind]) => kind === 'session')).toEqual([]);
  });

  it('measures retention against the session runtime clock', async () => {
    const { handle, runtime } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const artifact = await createFixtureArtifact();
    runtime.setTime(FIXTURE_NOW + FRESH_ATTEMPT_ARTIFACT_RETENTION_MS);

    expect(
      await rejectionOf(handle.startFreshAttempt({ artifact, instructions: INSTRUCTIONS })),
    ).toBeInstanceOf(StaleFreshAttemptArtifactError);
  });

  it('rejects an artifact dated after the session runtime clock before minting anything', async () => {
    const { handle, store, runtime } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const save = spyOn(store, 'save');
    const mint = spyOn(runtime.identifiers, 'next');
    const artifact = await createFixtureArtifact({ timestamp: '9999-01-01T00:00:00.000Z' });
    runtime.setTime(FIXTURE_NOW + 100 * FRESH_ATTEMPT_ARTIFACT_RETENTION_MS);

    const outcome = await handle.startFreshAttempt({ artifact, instructions: INSTRUCTIONS }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(StaleFreshAttemptArtifactError);
    expect((outcome as StaleFreshAttemptArtifactError).diagnostics).toEqual([
      { path: 'timestamp', rule: 'timestamp-in-future' },
    ]);
    expect(save).not.toHaveBeenCalled();
    expect(mint.mock.calls.filter(([kind]) => kind === 'session')).toEqual([]);
  });

  it('fails closed when the handle has no fresh-attempt source resolver', async () => {
    const { handle } = createSourceFixture();

    expect(
      await rejectionOf(
        handle.startFreshAttempt({
          artifact: await createFixtureArtifact(),
          instructions: INSTRUCTIONS,
        }),
      ),
    ).toBeInstanceOf(UnauthorizedFreshAttemptArtifactError);
  });

  it('returns a handle that can run the fresh conversation', async () => {
    const { handle } = createSourceFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const fresh = await handle.startFreshAttempt({
      artifact: await createFixtureArtifact(),
      instructions: INSTRUCTIONS,
    });

    await fresh.run('Continue from the handoff.').result();
    await yieldToPortableEventLoop();

    const { runs, conversationHistory } = await fresh.getSession();
    expect(runs).toHaveLength(1);
    const roles = conversationHistory.ids.map((id) => conversationHistory.messages[id]?.role);
    expect(roles).toEqual(['system', 'user', 'user', 'assistant']);
  });
});
