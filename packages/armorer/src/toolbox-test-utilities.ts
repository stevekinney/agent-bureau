import { checkBudget } from './toolbox-budget';
import { deriveRiskFromMetadata } from './toolbox-configuration';
import type { ImportedToolboxOptions, ToolboxOptions } from './toolbox-contracts';
import {
  createImportedExecute,
  createImportedToolbox,
  materializeImportedToolConfiguration,
} from './toolbox-imports';
import type { Toolbox } from './toolbox-interface';
import { normalizeToolCallArguments } from './toolbox-normalization';
import { mergePolicies, toPolicyContextProvider } from './toolbox-policy';
import { resolvePolicyDecision } from './toolbox-policy-decisions';
import { createLazyExecuteResolver } from './toolbox-registration';
import { isDangerousToolContext, isMutatingToolContext } from './toolbox-risk';
import { createCachedEmbedder, extractErrorCode } from './toolbox-runtime-helpers';
import type { ImportedToolConfiguration } from './toolbox-type-inference';
import { normalizeSchema as normalizeToolSchema } from './utilities/schema-normalization';

type CreateToolbox = (
  entries?: readonly import('./is-tool').ToolConfiguration[],
  options?: ToolboxOptions,
) => Toolbox;

export function createInternalToolboxTestUtilities(createToolbox: CreateToolbox) {
  return {
    checkBudget,
    createCachedEmbedder,
    createImportedExecute,
    createImportedToolbox: (
      configurations: ImportedToolConfiguration | readonly ImportedToolConfiguration[],
      options: ImportedToolboxOptions,
    ) => createImportedToolbox(configurations, options, createToolbox),
    createLazyExecuteResolver,
    deriveRiskFromMetadata,
    extractErrorCode,
    isDangerousToolContext,
    isMutatingToolContext,
    materializeImportedToolConfiguration,
    mergePolicies,
    normalizeToolCallArguments,
    normalizeToolSchema,
    resolvePolicyDecision,
    toPolicyContextProvider,
  };
}
