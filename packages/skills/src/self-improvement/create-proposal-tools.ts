import { createTool } from 'armorer';
import type { KeyValueStore } from 'storage';
import { z } from 'zod';

import type { SkillProvider } from '../types';
import {
  acceptProposal,
  type AcceptProposalOptions,
  getProposal,
  type IdentityProviderLike,
  listProposals,
  rejectProposal,
} from './proposals';

// ── Options ─────────────────────────────────────────────────────────

export interface CreateProposalToolboxOptions {
  storage: KeyValueStore;
  skillProvider: SkillProvider;
  identityProvider?: IdentityProviderLike;
}

// ── Individual Tool Factories ───────────────────────────────────────

/** Creates a tool that lists proposals with optional filters. */
export function createListProposalsTool(options: CreateProposalToolboxOptions) {
  return createTool({
    name: 'list_proposals',
    description: 'List self-improvement proposals with optional type and status filters',
    input: z.object({
      type: z.enum(['skill', 'soul', 'persona']).optional().describe('Filter by proposal type'),
      status: z
        .enum(['pending', 'accepted', 'rejected'])
        .optional()
        .describe('Filter by status (default: pending)'),
    }),
    async execute(params) {
      const proposals = await listProposals(options.storage, {
        type: params.type,
        status: params.status,
      });
      return {
        proposals: proposals.map((p) => ({
          id: p.id,
          type: p.type,
          summary: p.summary,
          status: p.status,
          agentId: p.agentId,
          createdAt: p.createdAt,
        })),
      };
    },
  });
}

/** Creates a tool that shows the full content of a proposal. */
export function createViewProposalTool(options: CreateProposalToolboxOptions) {
  return createTool({
    name: 'view_proposal',
    description: 'View the full content of a self-improvement proposal',
    input: z.object({
      id: z.string().describe('The proposal ID to view'),
    }),
    async execute(params) {
      const proposal = await getProposal(options.storage, params.id);
      if (!proposal) {
        return { found: false, error: `Proposal "${params.id}" not found.` };
      }
      return { found: true, proposal };
    },
  });
}

/** Creates a tool that accepts a proposal. */
export function createAcceptProposalTool(options: CreateProposalToolboxOptions) {
  const acceptOptions: AcceptProposalOptions = {
    skillProvider: options.skillProvider,
    identityProvider: options.identityProvider,
  };

  return createTool({
    name: 'accept_proposal',
    description: 'Accept a self-improvement proposal, applying its changes',
    input: z.object({
      id: z.string().describe('The proposal ID to accept'),
    }),
    async execute(params) {
      return acceptProposal(options.storage, params.id, acceptOptions);
    },
  });
}

/** Creates a tool that rejects a proposal. */
export function createRejectProposalTool(options: CreateProposalToolboxOptions) {
  return createTool({
    name: 'reject_proposal',
    description: 'Reject a self-improvement proposal with an optional reason',
    input: z.object({
      id: z.string().describe('The proposal ID to reject'),
      reason: z.string().optional().describe('Reason for rejection'),
    }),
    async execute(params) {
      return rejectProposal(options.storage, params.id, params.reason);
    },
  });
}

// ── Convenience Toolbox ─────────────────────────────────────────────

/** Creates all proposal management tools bundled together. */
export function createProposalToolbox(options: CreateProposalToolboxOptions) {
  return {
    listProposals: createListProposalsTool(options),
    viewProposal: createViewProposalTool(options),
    acceptProposal: createAcceptProposalTool(options),
    rejectProposal: createRejectProposalTool(options),
  };
}
