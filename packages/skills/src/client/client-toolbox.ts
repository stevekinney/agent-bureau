import { z } from 'zod';

import { createTool } from 'armorer';

import { scanSkillResource, type SkillGuardrailOptions } from '../guardrail';
import { renderActiveSkillInstructions, renderSkillCatalog } from './render';
import type { SkillClient } from './skill-client';

/**
 * Builds the model-facing tools for a client, or `undefined` when it has nothing to offer.
 *
 * `undefined` rather than an empty toolbox, and that distinction is the criterion: a model handed
 * an `activate_skill` tool with an empty catalog will try to use it, waste a turn discovering that
 * nothing exists, and sometimes invent a plausible name to pass. Exposing no tool at all is the
 * only honest representation of "this run has no skills".
 */
export function createSkillClientToolbox(
  client: SkillClient,
  options?: {
    /**
     * Scans a resource before it is returned to the model.
     *
     * Here rather than on the client because this is the boundary the content actually crosses:
     * the client owns the bundle, and a resource sitting in an admitted artifact has not reached
     * anyone. A client whose instructions were scanned but whose resources were not would leave
     * the larger half of a bundle unscanned, since `references/` is where the text lives.
     */
    readonly guardrail?: SkillGuardrailOptions;
  },
) {
  if (client.offered().length === 0) return undefined;

  return {
    activateSkill: createTool({
      name: 'activate_skill',
      description:
        'Activate a skill by name from the available skills, loading its full instructions.',
      input: z.object({
        name: z.string().describe('The skill name to activate'),
      }),
      async execute(params) {
        const outcome = await client.activate(params.name);
        if (!outcome.activated) {
          // The refusal reason is machine-readable and says nothing about skills the model was not
          // offered, so a rejected guess cannot be used to enumerate what exists.
          return { error: outcome.message, refusal: outcome.refusal, name: params.name };
        }
        return {
          name: params.name,
          instructions: renderActiveSkillInstructions(client.active()),
          digest: outcome.record.instructionsDigest,
        };
      },
    }),

    deactivateSkill: createTool({
      name: 'deactivate_skill',
      description: 'Deactivate a skill, removing its instructions from context.',
      input: z.object({
        name: z.string().describe('The skill name to deactivate'),
      }),
      // `async` because the tool contract requires a promise, even where the work is synchronous.
      async execute(params) {
        const outcome = client.deactivate(params.name);
        return outcome.deactivated
          ? { deactivated: true as const, name: params.name }
          : { error: 'Skill is not active', name: params.name };
      },
    }),

    loadSkillResource: createTool({
      name: 'load_skill_resource',
      description: 'Load a bundled resource from an active skill.',
      input: z.object({
        skillName: z.string().describe('The active skill name'),
        path: z.string().describe('The resource path within the skill bundle'),
      }),
      async execute(params) {
        const resource = client.loadResource(params.skillName, params.path);
        if (resource === undefined) {
          return {
            error: 'Resource not found, or the skill is not active',
            skillName: params.skillName,
            path: params.path,
          };
        }

        // `fatal: true` for the same reason the provider-backed tool uses it: a lossy decode hands
        // a guardrail replacement characters, which it scans and passes — a resource that appears
        // scanned and was not. A model cannot consume a binary asset anyway.
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes);
        } catch {
          return {
            error: 'Resource is not UTF-8 text and cannot be admitted to context',
            skillName: params.skillName,
            path: params.path,
            mediaType: resource.mediaType,
          };
        }

        if (options?.guardrail !== undefined) {
          const scan = await scanSkillResource(content, options.guardrail);
          if (scan.blocked) {
            return {
              error: 'Resource was blocked by a guardrail',
              skillName: params.skillName,
              path: params.path,
            };
          }
          // The scanned content, not the original: a `'warn'` action may redact in place, and
          // returning the pre-scan text would hand the model exactly what the detector rewrote.
          return { path: resource.path, mediaType: resource.mediaType, content: scan.content };
        }

        return { path: resource.path, mediaType: resource.mediaType, content };
      },
    }),
  };
}

/** The tier-one catalog block a host injects, or `undefined` when nothing is offered. */
export function renderClientCatalog(client: SkillClient): string | undefined {
  return renderSkillCatalog(client.offered());
}
