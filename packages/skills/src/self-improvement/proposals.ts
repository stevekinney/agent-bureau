import { z } from 'zod';

import { parseSkillMarkdown } from '../parse-skill-markdown';
import type { KeyValueStore, Proposal, SkillProvider } from '../types';

// ── Key Namespace ───────────────────────────────────────────────────

const PROPOSAL_PREFIX = 'proposal:';
const REJECTED_PATTERNS_KEY = 'proposal:rejected-patterns';

// ── Zod Schemas ─────────────────────────────────────────────────────

const proposalSchema = z.object({
  id: z.string(),
  type: z.enum(['skill', 'soul', 'persona']),
  summary: z.string(),
  content: z.string(),
  agentId: z.string().optional(),
  sourceEntryIds: z.array(z.string()),
  createdAt: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  rejectionReason: z.string().optional(),
});

const rejectedPatternsSchema = z.array(z.string());

// ── Structural Interfaces ───────────────────────────────────────────

/** Structural interface for identity provider, avoiding hard dependency on memory. */
export interface IdentityProviderLike {
  savePendingSoulUpdate(items: unknown[], agentId?: string): Promise<void>;
  savePersona(agentId: string, persona: { text?: string }): Promise<void>;
}

export interface ListProposalsOptions {
  /** Filter by proposal type. */
  type?: 'skill' | 'soul' | 'persona';
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by status. Default: 'pending'. */
  status?: 'pending' | 'accepted' | 'rejected';
}

export interface AcceptProposalOptions {
  /** Skill provider for accepting skill proposals. */
  skillProvider: SkillProvider;
  /** Identity provider for accepting soul/persona proposals. */
  identityProvider?: IdentityProviderLike;
}

// ── Hashing ─────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Parse JSON without throwing — returns undefined on malformed input. */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parseProposal(raw: string): Proposal | undefined {
  try {
    const parsed = proposalSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

// ── CRUD Functions ──────────────────────────────────────────────────

/** Save a proposal to storage. */
export async function saveProposal(storage: KeyValueStore, proposal: Proposal): Promise<void> {
  await storage.set(`${PROPOSAL_PREFIX}${proposal.id}`, JSON.stringify(proposal));
}

/** Get a specific proposal by ID. */
export async function getProposal(
  storage: KeyValueStore,
  id: string,
): Promise<Proposal | undefined> {
  const raw = await storage.get(`${PROPOSAL_PREFIX}${id}`);
  if (!raw) return undefined;
  return parseProposal(raw);
}

/** List proposals from storage with optional filters. */
export async function listProposals(
  storage: KeyValueStore,
  options?: ListProposalsOptions,
): Promise<Proposal[]> {
  const status = options?.status ?? 'pending';
  const keys = await storage.list(PROPOSAL_PREFIX);

  const proposals: Proposal[] = [];
  for (const key of keys) {
    // Skip the rejected-patterns key — it is not a proposal.
    if (key === REJECTED_PATTERNS_KEY) continue;

    const raw = await storage.get(key);
    if (!raw) continue;

    const proposal = parseProposal(raw);
    if (!proposal) continue;

    if (proposal.status !== status) continue;
    if (options?.type && proposal.type !== options.type) continue;
    if (options?.agentId && proposal.agentId !== options.agentId) continue;

    proposals.push(proposal);
  }

  return proposals;
}

// ── Accept / Reject ─────────────────────────────────────────────────

/**
 * Accept a proposal. Behavior depends on type:
 * - 'skill': Parse content as SKILL.md, write to SkillProvider.
 * - 'soul': Parse content as soul items JSON, write as pending soul update.
 * - 'persona': Update the persona text via identity provider.
 */
export async function acceptProposal(
  storage: KeyValueStore,
  id: string,
  options: AcceptProposalOptions,
): Promise<{ accepted: boolean; error?: string }> {
  const proposal = await getProposal(storage, id);
  if (!proposal) {
    return { accepted: false, error: `Proposal "${id}" not found.` };
  }

  try {
    switch (proposal.type) {
      case 'skill': {
        const skillContent = parseSkillMarkdown(proposal.content);
        await options.skillProvider.saveSkill(skillContent.metadata.name, skillContent);
        break;
      }

      case 'soul': {
        if (!options.identityProvider) {
          return {
            accepted: false,
            error: 'Identity provider required for soul proposals.',
          };
        }
        const soulItemsResult = z.array(z.unknown()).safeParse(JSON.parse(proposal.content));
        if (!soulItemsResult.success) {
          return {
            accepted: false,
            error: 'Soul proposal content is not a valid JSON array.',
          };
        }
        await options.identityProvider.savePendingSoulUpdate(
          soulItemsResult.data,
          proposal.agentId,
        );
        break;
      }

      case 'persona': {
        if (!options.identityProvider) {
          return {
            accepted: false,
            error: 'Identity provider required for persona proposals.',
          };
        }
        if (!proposal.agentId) {
          return {
            accepted: false,
            error: 'Persona proposals require an agentId.',
          };
        }
        await options.identityProvider.savePersona(proposal.agentId, {
          text: proposal.content,
        });
        break;
      }
    }

    const updated: Proposal = { ...proposal, status: 'accepted' };
    await saveProposal(storage, updated);

    return { accepted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { accepted: false, error: message };
  }
}

/**
 * Reject a proposal. Records the rejection reason and hashes the content
 * to prevent re-proposal of similar content.
 */
export async function rejectProposal(
  storage: KeyValueStore,
  id: string,
  reason?: string,
): Promise<{ rejected: boolean; error?: string }> {
  const proposal = await getProposal(storage, id);
  if (!proposal) {
    return { rejected: false, error: `Proposal "${id}" not found.` };
  }

  const updated: Proposal = {
    ...proposal,
    status: 'rejected',
    rejectionReason: reason,
  };
  await saveProposal(storage, updated);

  // Record the content hash in rejected patterns.
  const hash = hashContent(proposal.content);
  const rawPatterns = await storage.get(REJECTED_PATTERNS_KEY);
  const patternsResult = rejectedPatternsSchema.safeParse(safeJsonParse(rawPatterns ?? '[]'));
  const patterns = patternsResult.success ? patternsResult.data : [];
  if (!patterns.includes(hash)) {
    patterns.push(hash);
  }
  await storage.set(REJECTED_PATTERNS_KEY, JSON.stringify(patterns));

  return { rejected: true };
}

// ── Pattern Checking ────────────────────────────────────────────────

/**
 * Check if content is similar to a previously rejected proposal.
 * Uses simple string hashing for comparison.
 */
export async function isRejectedPattern(storage: KeyValueStore, content: string): Promise<boolean> {
  const hash = hashContent(content);
  const rawPatterns = await storage.get(REJECTED_PATTERNS_KEY);
  if (!rawPatterns) return false;

  const patternsResult = rejectedPatternsSchema.safeParse(safeJsonParse(rawPatterns));
  if (!patternsResult.success) return false;
  return patternsResult.data.includes(hash);
}

// ── Cleanup ─────────────────────────────────────────────────────────

/**
 * Clear old accepted/rejected proposals.
 */
export async function clearProposals(
  storage: KeyValueStore,
  options?: { status?: 'accepted' | 'rejected'; olderThanMs?: number },
): Promise<number> {
  const keys = await storage.list(PROPOSAL_PREFIX);
  let removed = 0;

  for (const key of keys) {
    if (key === REJECTED_PATTERNS_KEY) continue;

    const raw = await storage.get(key);
    if (!raw) continue;

    const proposal = parseProposal(raw);
    if (!proposal) continue;

    // When no status filter is given, only clear non-pending proposals.
    // Without this guard, pending (unreviewed) proposals would be silently deleted.
    const targetStatus = options?.status;
    if (targetStatus) {
      if (proposal.status !== targetStatus) continue;
    } else if (proposal.status === 'pending') {
      continue;
    }

    if (options?.olderThanMs) {
      const age = Date.now() - new Date(proposal.createdAt).getTime();
      if (age < options.olderThanMs) continue;
    }

    await storage.delete(key);
    removed++;
  }

  return removed;
}
