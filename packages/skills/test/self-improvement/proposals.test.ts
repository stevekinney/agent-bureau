import { describe, expect, it } from 'bun:test';

import type { IdentityProviderLike } from '../../src/self-improvement/proposals';
import {
  acceptProposal,
  clearProposals,
  getProposal,
  isRejectedPattern,
  listProposals,
  rejectProposal,
  saveProposal,
} from '../../src/self-improvement/proposals';
import { createMockSkillProvider, createMockStorageAdapter } from '../../src/test';
import type { Proposal } from '../../src/types';

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: crypto.randomUUID(),
    type: 'skill',
    summary: 'Test proposal',
    content: '---\nname: test-skill\ndescription: A test skill\n---\n\nDo the thing.',
    sourceEntryIds: ['entry-1'],
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...overrides,
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

describe('proposals', () => {
  describe('saveProposal and getProposal', () => {
    it('round-trips a proposal through storage', async () => {
      const storage = createMockStorageAdapter();
      const proposal = makeProposal({ id: 'proposal-1' });

      await saveProposal(storage, proposal);
      const retrieved = await getProposal(storage, 'proposal-1');

      expect(retrieved).toEqual(proposal);
    });

    it('returns undefined for a non-existent proposal', async () => {
      const storage = createMockStorageAdapter();
      const result = await getProposal(storage, 'does-not-exist');

      expect(result).toBeUndefined();
    });
  });

  describe('listProposals', () => {
    it('returns all pending proposals by default', async () => {
      const storage = createMockStorageAdapter();

      await saveProposal(storage, makeProposal({ id: 'p1', status: 'pending' }));
      await saveProposal(storage, makeProposal({ id: 'p2', status: 'pending' }));
      await saveProposal(storage, makeProposal({ id: 'p3', status: 'accepted' }));

      const result = await listProposals(storage);

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('filters by type', async () => {
      const storage = createMockStorageAdapter();

      await saveProposal(storage, makeProposal({ id: 'skill-1', type: 'skill' }));
      await saveProposal(storage, makeProposal({ id: 'soul-1', type: 'soul' }));
      await saveProposal(storage, makeProposal({ id: 'persona-1', type: 'persona' }));

      const result = await listProposals(storage, { type: 'soul' });

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('soul-1');
    });

    it('filters by agentId', async () => {
      const storage = createMockStorageAdapter();

      await saveProposal(storage, makeProposal({ id: 'p1', agentId: 'agent-a' }));
      await saveProposal(storage, makeProposal({ id: 'p2', agentId: 'agent-b' }));
      await saveProposal(storage, makeProposal({ id: 'p3' }));

      const result = await listProposals(storage, { agentId: 'agent-a' });

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('p1');
    });

    it('filters by status', async () => {
      const storage = createMockStorageAdapter();

      await saveProposal(storage, makeProposal({ id: 'p1', status: 'pending' }));
      await saveProposal(storage, makeProposal({ id: 'p2', status: 'accepted' }));
      await saveProposal(storage, makeProposal({ id: 'p3', status: 'rejected' }));

      const result = await listProposals(storage, { status: 'rejected' });

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('p3');
    });
  });

  describe('acceptProposal', () => {
    it('accepts a skill proposal and writes to skill provider', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({
        id: 'skill-proposal',
        type: 'skill',
        content: '---\nname: test-skill\ndescription: A test skill\n---\n\nDo the thing.',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'skill-proposal', { skillProvider });

      expect(result.accepted).toBe(true);

      const saveCalls = skillProvider.calls.filter((c) => c.method === 'saveSkill');
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]!.args[0]).toBe('test-skill');
    });

    it('sets the proposal status to accepted', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({ id: 'accept-me', type: 'skill' });
      await saveProposal(storage, proposal);

      await acceptProposal(storage, 'accept-me', { skillProvider });

      const updated = await getProposal(storage, 'accept-me');
      expect(updated?.status).toBe('accepted');
    });

    it('accepts a soul proposal and calls savePendingSoulUpdate', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();
      const identityProvider = createMockIdentityProvider();
      const soulItems = [{ id: 'item-1', content: 'Be helpful' }];
      const proposal = makeProposal({
        id: 'soul-proposal',
        type: 'soul',
        content: JSON.stringify(soulItems),
        agentId: 'agent-x',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'soul-proposal', {
        skillProvider,
        identityProvider,
      });

      expect(result.accepted).toBe(true);

      const soulCalls = identityProvider.calls.filter((c) => c.method === 'savePendingSoulUpdate');
      expect(soulCalls).toHaveLength(1);
      expect(soulCalls[0]!.args[0]).toEqual(soulItems);
      expect(soulCalls[0]!.args[1]).toBe('agent-x');
    });

    it('accepts a persona proposal and calls savePersona', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();
      const identityProvider = createMockIdentityProvider();
      const proposal = makeProposal({
        id: 'persona-proposal',
        type: 'persona',
        content: 'You are a friendly assistant.',
        agentId: 'agent-y',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'persona-proposal', {
        skillProvider,
        identityProvider,
      });

      expect(result.accepted).toBe(true);

      const personaCalls = identityProvider.calls.filter((c) => c.method === 'savePersona');
      expect(personaCalls).toHaveLength(1);
      expect(personaCalls[0]!.args[0]).toBe('agent-y');
      expect(personaCalls[0]!.args[1]).toEqual({ text: 'You are a friendly assistant.' });
    });

    it('returns an error for a non-existent proposal', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();

      const result = await acceptProposal(storage, 'nope', { skillProvider });

      expect(result.accepted).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns an error for a soul proposal without identityProvider', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({
        id: 'soul-no-identity',
        type: 'soul',
        content: JSON.stringify([{ id: 'item-1', content: 'Be helpful' }]),
        agentId: 'agent-x',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'soul-no-identity', { skillProvider });

      expect(result.accepted).toBe(false);
      expect(result.error).toBe('Identity provider required for soul proposals.');
    });

    it('returns an error for a persona proposal without identityProvider', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({
        id: 'persona-no-identity',
        type: 'persona',
        content: 'You are a helpful assistant.',
        agentId: 'agent-y',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'persona-no-identity', { skillProvider });

      expect(result.accepted).toBe(false);
      expect(result.error).toBe('Identity provider required for persona proposals.');
    });

    it('returns an error for a persona proposal without agentId', async () => {
      const storage = createMockStorageAdapter();
      const skillProvider = createMockSkillProvider();
      const identityProvider = createMockIdentityProvider();
      const proposal = makeProposal({
        id: 'persona-no-agent',
        type: 'persona',
        content: 'You are a helpful assistant.',
        // no agentId
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'persona-no-agent', {
        skillProvider,
        identityProvider,
      });

      expect(result.accepted).toBe(false);
      expect(result.error).toBe('Persona proposals require an agentId.');
    });
  });

  describe('rejectProposal', () => {
    it('sets the proposal status to rejected and records reason', async () => {
      const storage = createMockStorageAdapter();
      const proposal = makeProposal({ id: 'reject-me' });
      await saveProposal(storage, proposal);

      const result = await rejectProposal(storage, 'reject-me', 'Low quality');

      expect(result.rejected).toBe(true);

      const updated = await getProposal(storage, 'reject-me');
      expect(updated?.status).toBe('rejected');
      expect(updated?.rejectionReason).toBe('Low quality');
    });

    it('hashes content and stores in rejected patterns', async () => {
      const storage = createMockStorageAdapter();
      const proposal = makeProposal({ id: 'reject-hash', content: 'unique-content-to-reject' });
      await saveProposal(storage, proposal);

      await rejectProposal(storage, 'reject-hash', 'Not useful');

      const isRejected = await isRejectedPattern(storage, 'unique-content-to-reject');
      expect(isRejected).toBe(true);
    });

    it('returns an error for a non-existent proposal', async () => {
      const storage = createMockStorageAdapter();

      const result = await rejectProposal(storage, 'does-not-exist');

      expect(result.rejected).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('isRejectedPattern', () => {
    it('returns true for previously rejected content', async () => {
      const storage = createMockStorageAdapter();
      const proposal = makeProposal({ id: 'r1', content: 'content-to-reject' });
      await saveProposal(storage, proposal);
      await rejectProposal(storage, 'r1');

      const result = await isRejectedPattern(storage, 'content-to-reject');
      expect(result).toBe(true);
    });

    it('returns false for new content', async () => {
      const storage = createMockStorageAdapter();

      const result = await isRejectedPattern(storage, 'brand-new-content');
      expect(result).toBe(false);
    });
  });

  describe('clearProposals', () => {
    it('removes proposals matching the given status', async () => {
      const storage = createMockStorageAdapter();

      await saveProposal(storage, makeProposal({ id: 'p1', status: 'accepted' }));
      await saveProposal(storage, makeProposal({ id: 'p2', status: 'rejected' }));
      await saveProposal(storage, makeProposal({ id: 'p3', status: 'pending' }));

      const removed = await clearProposals(storage, { status: 'accepted' });

      expect(removed).toBe(1);
      expect(await getProposal(storage, 'p1')).toBeUndefined();
      expect(await getProposal(storage, 'p2')).toBeDefined();
      expect(await getProposal(storage, 'p3')).toBeDefined();
    });

    it('removes old proposals when olderThanMs is specified', async () => {
      const storage = createMockStorageAdapter();

      const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();

      await saveProposal(
        storage,
        makeProposal({ id: 'old', status: 'accepted', createdAt: oldDate }),
      );
      await saveProposal(
        storage,
        makeProposal({ id: 'recent', status: 'accepted', createdAt: recentDate }),
      );

      const removed = await clearProposals(storage, {
        status: 'accepted',
        olderThanMs: 24 * 60 * 60 * 1000,
      });

      expect(removed).toBe(1);
      expect(await getProposal(storage, 'old')).toBeUndefined();
      expect(await getProposal(storage, 'recent')).toBeDefined();
    });
  });
});
