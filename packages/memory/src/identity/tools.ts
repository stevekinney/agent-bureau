import { createTool } from 'armorer';
import { z } from 'zod';

import { resolveIdentity } from './resolve-identity';
import {
  acceptSoulUpdate,
  getSoulDiff,
  pinSoulItem,
  rejectSoulUpdate,
  unpinSoulItem,
} from './soul-approval';
import type { IdentityProvider, PersonaDescriptor } from './types';

// ── Soul Tools ─────────────────────────────────────────────────────

/**
 * Creates a tool that shows the pending soul update diff.
 */
export function createSoulDiffTool(provider: IdentityProvider) {
  return createTool({
    name: 'soul_diff',
    description: 'Show the pending soul update diff (additions, removals, changes)',
    input: z.object({
      agentId: z.string().optional().describe('Agent ID (omit for orchestrator)'),
    }),
    async execute(params) {
      const diff = await getSoulDiff(provider, params.agentId);
      return diff;
    },
  });
}

/**
 * Creates a tool that accepts the pending soul update.
 */
export function createSoulAcceptTool(provider: IdentityProvider) {
  return createTool({
    name: 'soul_accept',
    description: 'Accept the pending soul update',
    input: z.object({
      agentId: z.string().optional().describe('Agent ID (omit for orchestrator)'),
    }),
    async execute(params) {
      const result = await acceptSoulUpdate(provider, params.agentId);
      if (!result) {
        return { accepted: false, reason: 'No pending update found.' };
      }
      return { accepted: true, version: result.version };
    },
  });
}

/**
 * Creates a tool that rejects the pending soul update.
 */
export function createSoulRejectTool(provider: IdentityProvider) {
  return createTool({
    name: 'soul_reject',
    description: 'Reject the pending soul update',
    input: z.object({
      agentId: z.string().optional().describe('Agent ID (omit for orchestrator)'),
      reason: z.string().optional().describe('Optional rejection reason'),
    }),
    async execute(params) {
      await rejectSoulUpdate(provider, params.agentId);
      return { rejected: true, reason: params.reason };
    },
  });
}

/**
 * Creates a tool that pins a soul item.
 */
export function createSoulPinTool(provider: IdentityProvider) {
  return createTool({
    name: 'soul_pin',
    description: 'Pin or unpin a soul item',
    input: z.object({
      itemId: z.string().describe('The soul item ID to pin/unpin'),
      pinned: z.boolean().describe('True to pin, false to unpin'),
      agentId: z.string().optional().describe('Agent ID (omit for orchestrator)'),
    }),
    async execute(params) {
      const result = params.pinned
        ? await pinSoulItem(provider, params.itemId, params.agentId)
        : await unpinSoulItem(provider, params.itemId, params.agentId);
      if (!result) {
        return { success: false, reason: `Soul item "${params.itemId}" not found.` };
      }
      return { success: true, itemId: params.itemId, pinned: params.pinned };
    },
  });
}

/**
 * Creates a tool that views the current soul.
 */
export function createSoulViewTool(provider: IdentityProvider) {
  return createTool({
    name: 'soul_view',
    description: 'View the current soul document',
    input: z.object({
      agentId: z.string().optional().describe('Agent ID (omit for orchestrator)'),
    }),
    async execute(params) {
      const soul = await provider.loadSoul(params.agentId);
      const persona = params.agentId ? await provider.loadPersona(params.agentId) : undefined;
      const userContext = await provider.loadUserContext();

      const resolved = resolveIdentity({
        soul,
        persona: persona?.descriptor,
        personaText: persona?.text,
        userContext,
      });

      return { items: soul, rendered: resolved };
    },
  });
}

// ── Persona Tools ──────────────────────────────────────────────────

/**
 * Creates a tool that lists all registered personas.
 */
export function createPersonaListTool(provider: IdentityProvider) {
  return createTool({
    name: 'persona_list',
    description: 'List all registered agent personas',
    input: z.object({}),
    async execute() {
      const agentIds = await provider.listPersonas();
      const personas = await Promise.all(
        agentIds.map(async (agentId) => {
          const persona = await provider.loadPersona(agentId);
          return { agentId, descriptor: persona?.descriptor, text: persona?.text };
        }),
      );
      return { personas };
    },
  });
}

/**
 * Creates a tool that views a specific persona.
 */
export function createPersonaViewTool(provider: IdentityProvider) {
  return createTool({
    name: 'persona_view',
    description: 'View details for a specific agent persona',
    input: z.object({
      agentId: z.string().describe('The agent ID to view'),
    }),
    async execute(params) {
      const persona = await provider.loadPersona(params.agentId);
      if (!persona) {
        return { found: false, agentId: params.agentId };
      }
      return { found: true, agentId: params.agentId, ...persona };
    },
  });
}

const personaDescriptorSchema = z.object({
  name: z.string().describe('The persona display name'),
  role: z.string().describe('What this agent does'),
  expertise: z.string().optional().describe('Domain of expertise'),
  taskContext: z.string().optional().describe('Task context this agent is suited for'),
  domain: z.string().optional().describe('Knowledge domain'),
});

/**
 * Creates a tool that creates a new persona.
 */
export function createPersonaCreateTool(provider: IdentityProvider) {
  return createTool({
    name: 'persona_create',
    description: 'Create a new agent persona',
    input: z.object({
      agentId: z.string().describe('The agent ID for this persona'),
      descriptor: personaDescriptorSchema.describe('Structured persona metadata'),
      text: z.string().optional().describe('Free-text behavioral instructions'),
    }),
    async execute(params) {
      await provider.savePersona(params.agentId, {
        descriptor: params.descriptor as PersonaDescriptor,
        text: params.text,
      });
      return { created: true, agentId: params.agentId };
    },
  });
}

/**
 * Creates a tool that updates an existing persona.
 */
export function createPersonaUpdateTool(provider: IdentityProvider) {
  return createTool({
    name: 'persona_update',
    description: 'Update an existing agent persona',
    input: z.object({
      agentId: z.string().describe('The agent ID to update'),
      descriptor: personaDescriptorSchema
        .partial()
        .optional()
        .describe('Partial descriptor to merge'),
      text: z.string().optional().describe('Updated behavioral instructions'),
    }),
    async execute(params) {
      const existing = await provider.loadPersona(params.agentId);
      if (!existing) {
        return { updated: false, reason: `Persona "${params.agentId}" not found.` };
      }

      const updatedDescriptor = params.descriptor
        ? { ...existing.descriptor, ...params.descriptor }
        : existing.descriptor;

      await provider.savePersona(params.agentId, {
        descriptor: updatedDescriptor as PersonaDescriptor | undefined,
        text: params.text ?? existing.text,
      });

      return { updated: true, agentId: params.agentId };
    },
  });
}

/**
 * Creates a tool that deletes a persona.
 */
export function createPersonaDeleteTool(provider: IdentityProvider) {
  return createTool({
    name: 'persona_delete',
    description: 'Delete an agent persona',
    input: z.object({
      agentId: z.string().describe('The agent ID to delete'),
    }),
    async execute(params) {
      await provider.deletePersona(params.agentId);
      return { deleted: true, agentId: params.agentId };
    },
  });
}

// ── Convenience Toolbox ────────────────────────────────────────────

/**
 * Creates all identity management tools bundled together.
 */
export function createIdentityToolbox(provider: IdentityProvider) {
  return {
    soulDiff: createSoulDiffTool(provider),
    soulAccept: createSoulAcceptTool(provider),
    soulReject: createSoulRejectTool(provider),
    soulPin: createSoulPinTool(provider),
    soulView: createSoulViewTool(provider),
    personaList: createPersonaListTool(provider),
    personaView: createPersonaViewTool(provider),
    personaCreate: createPersonaCreateTool(provider),
    personaUpdate: createPersonaUpdateTool(provider),
    personaDelete: createPersonaDeleteTool(provider),
  };
}
