/**
 * The typed agent discovery tool (AB-22) — moved here from operative,
 * rebuilt against `BureauAgentCatalog<D>` instead of the deleted
 * `AgentRegistry`. Exposes metadata only: `RunnableAgent` carries no
 * description/capabilities/tags, so there is nothing beyond an agent's name
 * for this tool to search or return.
 */

import { createTool } from 'armorer';
import { z } from 'zod';

import type { AgentDefinitions, BureauAgentCatalog } from './agent-catalog';

/**
 * Creates a tool that lets an orchestrating agent discover the names of
 * agents registered on this bureau's catalog. `text`, when supplied,
 * case-insensitively substring-matches against agent names — the
 * predecessor `AgentRegistry.query({text})`'s case-insensitive semantics,
 * the one part of that search still meaningful once name is the only
 * searchable field.
 */
export function createAgentDiscoveryTool<D extends AgentDefinitions>(
  catalog: BureauAgentCatalog<D>,
) {
  return createTool({
    name: 'discover-agents',
    description: 'Discover available agents on this bureau by searching their names.',
    input: z.object({
      text: z
        .string()
        .optional()
        .describe('Search text to match (case-insensitively) against agent names.'),
    }),
    execute: ({ text }) => {
      const lowerText = text?.toLowerCase();
      const names = catalog
        .names()
        .filter((name) => !lowerText || name.toLowerCase().includes(lowerText));
      return Promise.resolve(JSON.stringify(names.map((name) => ({ name }))));
    },
  });
}
