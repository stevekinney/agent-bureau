import { beforeEach, describe, expect, it, mock } from 'bun:test';

import type { IdentityProviderLike } from '../../src/self-improvement/proposals';
import { getProposal, listProposals } from '../../src/self-improvement/proposals';
import { reflectionSweep } from '../../src/self-improvement/reflection-sweep';
import type { StepResultLike } from '../../src/skill-memory';
import { createMockKeyValueStore, createMockSkillProvider } from '../../src/test';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function createMockConversation(messages: Array<{ role: string; content: string }>) {
  return {
    getMessages() {
      return messages;
    },
  };
}

function createStepResult(overrides?: Partial<StepResultLike>): StepResultLike {
  return {
    step: 1,
    conversation: createMockConversation([
      { role: 'user', content: 'Help me refactor the auth module' },
      { role: 'assistant', content: 'I will break the refactor into three steps.' },
      { role: 'user', content: 'Sounds good, proceed.' },
      { role: 'assistant', content: 'Refactoring complete. All tests pass.' },
    ]),
    content: 'Refactoring complete. All tests pass.',
    final: true,
    metadata: {},
    ...overrides,
  };
}

function createMockMemory() {
  const entries: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  return {
    entries,
    remember: mock(async (content: string, metadata?: Record<string, unknown>) => {
      entries.push({ content, metadata: metadata ?? {} });
      return {};
    }),
    recall: mock(async () => []),
  };
}

function createMockIdentityProvider(): IdentityProviderLike & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async savePendingSoulUpdate(items: unknown[], agentId?: string): Promise<void> {
      calls.push({ method: 'savePendingSoulUpdate', args: [items, agentId] });
    },
    async savePersona(agentId: string, persona: { text?: string }): Promise<void> {
      calls.push({ method: 'savePersona', args: [agentId, persona] });
    },
  };
}

// ── memory sink ───────────────────────────────────────────────────────────────

describe('reflectionSweep — memory sink', () => {
  let memory: ReturnType<typeof createMockMemory>;

  beforeEach(() => {
    memory = createMockMemory();
  });

  it('calls reflect with the run summary on the final step', async () => {
    const reflect = mock(async (summary: string) => `Insight: ${summary.slice(0, 30)}`);
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(createStepResult());

    expect(reflect).toHaveBeenCalledTimes(1);
    const calledWith = reflect.mock.calls[0]![0];
    expect(calledWith).toContain('## Run Summary');
    expect(calledWith).toContain('Initial query:');
  });

  it('writes the insight to memory with experiential metadata', async () => {
    const reflect = mock(async () => 'Always run integration tests before refactoring auth.');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory, namespace: 'experiential' },
      reflect,
    });

    await onStep(createStepResult());

    expect(memory.remember).toHaveBeenCalledTimes(1);
    const { content, metadata } = memory.entries[0]!;
    expect(content).toBe('Always run integration tests before refactoring auth.');
    expect(metadata['source']).toBe('experiential');
    expect(metadata['namespace']).toBe('experiential');
    expect(metadata['tags']).toEqual(['strategy']);
  });

  it('defaults namespace to "experiential" when not specified', async () => {
    const reflect = mock(async () => 'insight');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(createStepResult());

    expect(memory.entries[0]!.metadata['namespace']).toBe('experiential');
  });

  it('forwards agentId and finishReason from step metadata', async () => {
    const reflect = mock(async () => 'agent-specific insight');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(
      createStepResult({ metadata: { agentId: 'refactor-agent', finishReason: 'stop' } }),
    );

    const { metadata } = memory.entries[0]!;
    expect(metadata['agentId']).toBe('refactor-agent');
    expect(metadata['finishReason']).toBe('stop');
  });

  it('is a no-op on non-final steps', async () => {
    const reflect = mock(async () => 'insight');
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(memory.remember).not.toHaveBeenCalled();
  });

  it('is a no-op when shouldReflect returns false', async () => {
    const reflect = mock(async () => 'insight');
    const shouldReflect = mock((_: StepResultLike) => false);
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
      shouldReflect,
    });

    await onStep(createStepResult());

    expect(shouldReflect).toHaveBeenCalledTimes(1);
    expect(reflect).not.toHaveBeenCalled();
  });

  it('fires when shouldReflect returns true', async () => {
    const reflect = mock(async () => 'good insight');
    const shouldReflect = mock(() => true);
    const { onStep } = reflectionSweep({
      sink: { type: 'memory', memory },
      reflect,
      shouldReflect,
    });

    await onStep(createStepResult());

    expect(reflect).toHaveBeenCalledTimes(1);
    expect(memory.entries).toHaveLength(1);
  });
});

// ── skill sink ────────────────────────────────────────────────────────────────

describe('reflectionSweep — skill sink', () => {
  it('creates a pending skill proposal in storage', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(
      async () => '---\nname: test-skill\ndescription: A new skill\n---\n\nDo the thing.',
    );

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.type).toBe('skill');
    expect(proposal.status).toBe('pending');
    expect(proposal.content).toContain('test-skill');
  });

  it('creates a skill proposal with an optional agentId', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => '---\nname: agent-skill\ndescription: Skills\n---\n\nBody.');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider, agentId: 'agent-42' },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals[0]!.agentId).toBe('agent-42');
  });

  it('is a no-op on non-final steps', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });

  it('uses a custom proposalSummary when provided', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill content');
    const proposalSummary = mock(() => 'Custom summary');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
      proposalSummary,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals[0]!.summary).toBe('Custom summary');
    expect(proposalSummary).toHaveBeenCalledTimes(1);
  });
});

// ── soul sink ─────────────────────────────────────────────────────────────────

describe('reflectionSweep — soul sink', () => {
  it('creates a pending soul proposal in storage', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const soulContent = JSON.stringify([{ id: 'item-1', content: 'Be helpful' }]);
    const reflect = mock(async () => soulContent);

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.type).toBe('soul');
    expect(proposal.status).toBe('pending');
    expect(proposal.content).toBe(soulContent);
  });

  it('creates a soul proposal with an optional agentId', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => '[]');

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider, agentId: 'soul-agent' },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals[0]!.agentId).toBe('soul-agent');
  });

  it('is a no-op on non-final steps', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => '[]');

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });
});

// ── persona sink ──────────────────────────────────────────────────────────────

describe('reflectionSweep — persona sink', () => {
  it('creates a pending persona proposal in storage', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => 'You are a meticulous refactoring assistant.');

    const { onStep } = reflectionSweep({
      sink: { type: 'persona', storage, identityProvider, agentId: 'refactor-agent' },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.type).toBe('persona');
    expect(proposal.status).toBe('pending');
    expect(proposal.content).toBe('You are a meticulous refactoring assistant.');
    expect(proposal.agentId).toBe('refactor-agent');
  });

  it('is a no-op on non-final steps', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => 'persona content');

    const { onStep } = reflectionSweep({
      sink: { type: 'persona', storage, identityProvider, agentId: 'agent-x' },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });
});

// ── cross-sink: shouldReflect ─────────────────────────────────────────────────

describe('reflectionSweep — shouldReflect predicate (cross-sink)', () => {
  it('skill sink: honours shouldReflect returning false', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
      shouldReflect: () => false,
    });

    await onStep(createStepResult());

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });

  it('soul sink: honours shouldReflect returning false', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => '[]');

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider },
      reflect,
      shouldReflect: () => false,
    });

    await onStep(createStepResult());

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });
});

// ── proposal field integrity ──────────────────────────────────────────────────

describe('reflectionSweep — proposal field integrity', () => {
  it('proposal has a unique id, createdAt, and empty sourceEntryIds', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    const proposal = proposals[0]!;
    expect(proposal.id).toBeTruthy();
    expect(proposal.createdAt).toBeTruthy();
    expect(new Date(proposal.createdAt).getTime()).not.toBeNaN();
    expect(proposal.sourceEntryIds).toEqual([]);
  });

  it('each call produces a distinct proposal id', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());
    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.id).not.toBe(proposals[1]!.id);
  });

  it('can retrieve the created proposal by id', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill proposal content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    const id = proposals[0]!.id;
    const retrieved = await getProposal(storage, id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe('skill proposal content');
  });
});
