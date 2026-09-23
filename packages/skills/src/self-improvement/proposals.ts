import { sha256HexSync } from '@lostgradient/cryptography';
import type { RuntimeServices } from '@lostgradient/lifecycle';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { TextValueStore } from '@lostgradient/weft';
import { z } from 'zod';

import { parseSkillMarkdown } from '../parse-skill-markdown';
import type { Proposal, SkillWriter } from '../types';

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
  skillProvider: SkillWriter;
  /** Identity provider for accepting soul/persona proposals. */
  identityProvider?: IdentityProviderLike;
}

// ── Hashing ─────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return sha256HexSync(content);
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
    const data = parsed.data;
    return {
      id: data.id,
      type: data.type,
      summary: data.summary,
      content: data.content,
      sourceEntryIds: data.sourceEntryIds,
      createdAt: data.createdAt,
      status: data.status,
      ...(data.agentId !== undefined ? { agentId: data.agentId } : {}),
      ...(data.rejectionReason !== undefined ? { rejectionReason: data.rejectionReason } : {}),
    };
  } catch {
    return undefined;
  }
}

function matchesProposal(
  proposal: Proposal,
  options: ListProposalsOptions | undefined,
  status: Proposal['status'],
): boolean {
  return (
    proposal.status === status &&
    (options?.type === undefined || proposal.type === options.type) &&
    (options?.agentId === undefined || proposal.agentId === options.agentId)
  );
}

async function acceptSkillProposal(proposal: Proposal, skillProvider: SkillWriter): Promise<void> {
  const skillContent = parseSkillMarkdown(proposal.content);
  await skillProvider.saveSkill(skillContent.metadata.name, skillContent);
}

async function acceptSoulProposal(
  proposal: Proposal,
  identityProvider: IdentityProviderLike | undefined,
): Promise<void> {
  if (!identityProvider) throw new Error('Identity provider required for soul proposals.');
  const soulItemsResult = z.array(z.unknown()).safeParse(JSON.parse(proposal.content));
  if (!soulItemsResult.success) throw new Error('Soul proposal content is not a valid JSON array.');
  await identityProvider.savePendingSoulUpdate(soulItemsResult.data, proposal.agentId);
}

async function acceptPersonaProposal(
  proposal: Proposal,
  identityProvider: IdentityProviderLike | undefined,
): Promise<void> {
  if (!identityProvider) throw new Error('Identity provider required for persona proposals.');
  if (!proposal.agentId) throw new Error('Persona proposals require an agentId.');
  await identityProvider.savePersona(proposal.agentId, { text: proposal.content });
}

async function acceptProposalContent(
  proposal: Proposal,
  options: AcceptProposalOptions,
): Promise<void> {
  switch (proposal.type) {
    case 'skill':
      await acceptSkillProposal(proposal, options.skillProvider);
      return;
    case 'soul':
      await acceptSoulProposal(proposal, options.identityProvider);
      return;
    case 'persona':
      await acceptPersonaProposal(proposal, options.identityProvider);
      return;
  }
}

function shouldClearProposal(
  proposal: Proposal,
  options: { status?: 'accepted' | 'rejected'; olderThanMs?: number },
  now: number,
): boolean {
  if (options.status ? proposal.status !== options.status : proposal.status === 'pending') {
    return false;
  }
  if (options.olderThanMs === undefined) return true;
  return now - new Date(proposal.createdAt).getTime() >= options.olderThanMs;
}

// ── CRUD Functions ──────────────────────────────────────────────────

/** Save a proposal to storage. */
export async function saveProposal(storage: TextValueStore, proposal: Proposal): Promise<void> {
  await storage.set(`${PROPOSAL_PREFIX}${proposal.id}`, JSON.stringify(proposal));
}

/** Get a specific proposal by ID. */
export async function getProposal(
  storage: TextValueStore,
  id: string,
): Promise<Proposal | undefined> {
  const raw = await storage.get(`${PROPOSAL_PREFIX}${id}`);
  if (!raw) return undefined;
  return parseProposal(raw);
}

/** List proposals from storage with optional filters. */
export async function listProposals(
  storage: TextValueStore,
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

    if (!matchesProposal(proposal, options, status)) continue;

    proposals.push(proposal);
  }

  return proposals;
}

// ── Accept / Reject ─────────────────────────────────────────────────

/**
 * Accept a proposal. Behavior depends on type:
 * - 'skill': Parse content as SKILL.md, write to SkillWriter.
 * - 'soul': Parse content as soul items JSON, write as pending soul update.
 * - 'persona': Update the persona text via identity provider.
 */
export async function acceptProposal(
  storage: TextValueStore,
  id: string,
  options: AcceptProposalOptions,
): Promise<{ accepted: boolean; error?: string }> {
  const proposal = await getProposal(storage, id);
  if (!proposal) {
    return { accepted: false, error: `Proposal "${id}" not found.` };
  }

  try {
    await acceptProposalContent(proposal, options);

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
  storage: TextValueStore,
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
    ...(reason !== undefined ? { rejectionReason: reason } : {}),
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
export async function isRejectedPattern(
  storage: TextValueStore,
  content: string,
): Promise<boolean> {
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
  storage: TextValueStore,
  options?: {
    status?: 'accepted' | 'rejected';
    olderThanMs?: number;
    /** Runtime to read the current time from. Defaults to the real clock. */
    runtime?: RuntimeServices;
  },
): Promise<number> {
  const runtime = options?.runtime ?? createDefaultRuntimeServices();
  const keys = await storage.list(PROPOSAL_PREFIX);
  let removed = 0;

  for (const key of keys) {
    if (key === REJECTED_PATTERNS_KEY) continue;

    const raw = await storage.get(key);
    if (!raw) continue;

    const proposal = parseProposal(raw);
    if (!proposal) continue;

    if (!shouldClearProposal(proposal, options ?? {}, runtime.clock.now())) continue;

    await storage.delete(key);
    removed++;
  }

  return removed;
}
