import { normalizeName, type ResolutionTier } from '../../resolution';
import { ToolboxNameResolvedEvent } from '../../toolbox-discovery-events';
import type { ToolRegistry } from './registry';

/**
 * Result of attempting to resolve a tool name.
 */
export type RegistryResolutionResult = {
  /** The resolved tool name, or null if not found or ambiguous. */
  resolved: string | null;
  /** The tier at which resolution succeeded. */
  tier: ResolutionTier;
  /** List of tool names that match ambiguously (if resolution failed due to ambiguity). */
  ambiguous?: string[];
};

/**
 * Options for controlling resolution behavior.
 */
export type ResolveNameOptions = {
  /** Restrict resolution to specific tiers. Defaults to all tiers. */
  restrictTo?: ResolutionTier[];
  /** Whether to allow deprecated tools. Defaults to false. */
  allowDeprecated?: boolean;
};

/**
 * Builds candidate names for matching.
 * This is primarily used for testing normalization behavior.
 * Returns the normalized name and all right-anchored suffixes in order.
 *
 * @param name The name to build candidates for
 * @returns Array of candidates in deterministic order
 */
export function buildRegistryNameCandidates(name: string): string[] {
  const normalized = normalizeName(name);
  const candidates: string[] = [normalized];

  // Generate suffix candidates: all suffixes from length-1 down to 1
  // This produces the input name and then all right-anchored suffixes
  for (let i = 1; i < normalized.length; i++) {
    candidates.push(normalized.slice(i));
  }

  return candidates;
}

/**
 * Filters tool names to include only non-deprecated tools if required.
 * @param toolNames Names of tools to filter
 * @param tools List of all tools from registry
 * @param allowDeprecated Whether to allow deprecated tools
 * @returns Filtered list of tool names
 */
function filterDeprecated(
  toolNames: string[],
  tools: ReturnType<ToolRegistry['tools']>,
  allowDeprecated: boolean,
): string[] {
  if (allowDeprecated) return toolNames;

  const toolsByName = new Map(tools.map((tool) => [tool.identity.name, tool]));

  return toolNames.filter((name) => {
    const tool = toolsByName.get(name);
    return tool && !tool.lifecycle?.deprecated;
  });
}

/**
 * Attempts to resolve a tool name using fuzzy matching with tier-based fallback.
 *
 * Resolution tiers (in order):
 * 1. **Exact**: The input matches a tool name exactly (case-sensitive, separator-sensitive)
 * 2. **Case-insensitive**: The input lowercased matches a lowercased tool name (separators unchanged)
 * 3. **Normalized**: The input normalized matches a normalized tool name (case + separators standardized)
 * 4. **Suffix**: The input (normalized) appears as a substring in a normalized tool name
 *
 * Ambiguity occurs when multiple tools match at the same tier. In this case, `resolved` is null
 * and `ambiguous` contains the matching tool names.
 *
 * @param input The tool name to resolve
 * @param registry The tool registry
 * @param options Resolution options
 * @param dispatchEvent Optional event dispatcher for emitting resolution events
 * @returns Resolution result with resolved name and tier
 */
export function resolveName(
  input: string,
  registry: ToolRegistry,
  options?: ResolveNameOptions,
  dispatchEvent?: (event: Event) => boolean,
): RegistryResolutionResult {
  const context = createResolutionContext(input, registry, options, dispatchEvent);
  for (const resolver of tierResolvers) {
    const result = resolver(context);
    if (result) return result;
  }
  return { resolved: null, tier: 'exact' };
}

type ResolutionContext = {
  input: string;
  allTools: ReturnType<ToolRegistry['tools']>;
  toolNames: Set<string>;
  allowDeprecated: boolean;
  restrictedTiers: ResolutionTier[] | undefined;
  dispatchEvent: ((event: Event) => boolean) | undefined;
};

type TierResolver = (context: ResolutionContext) => RegistryResolutionResult | null;

const tierResolvers: readonly TierResolver[] = [
  resolveExactTier,
  resolveCaseInsensitiveTier,
  resolveNormalizedTier,
  resolveSuffixTier,
];

function createResolutionContext(
  input: string,
  registry: ToolRegistry,
  options: ResolveNameOptions | undefined,
  dispatchEvent: ((event: Event) => boolean) | undefined,
): ResolutionContext {
  return {
    input,
    allTools: registry.tools(),
    toolNames: new Set(registry.tools().map((tool) => tool.identity.name)),
    allowDeprecated: options?.allowDeprecated ?? false,
    restrictedTiers: options?.restrictTo,
    dispatchEvent,
  };
}

function resolveExactTier(context: ResolutionContext): RegistryResolutionResult | null {
  if (!shouldTryTier(context, 'exact')) return null;
  return context.toolNames.has(context.input)
    ? buildResult(context, 'exact', [context.input])
    : null;
}

function resolveCaseInsensitiveTier(context: ResolutionContext): RegistryResolutionResult | null {
  if (!shouldTryTier(context, 'case-insensitive')) return null;
  const inputLowercased = context.input.toLowerCase();
  return buildNonEmptyResult(
    context,
    'case-insensitive',
    [...context.toolNames].filter((name) => name.toLowerCase() === inputLowercased),
  );
}

function resolveNormalizedTier(context: ResolutionContext): RegistryResolutionResult | null {
  if (!shouldTryTier(context, 'normalized')) return null;
  const normalized = normalizeName(context.input);
  return buildNonEmptyResult(
    context,
    'normalized',
    [...context.toolNames].filter((name) => normalizeName(name) === normalized),
  );
}

function resolveSuffixTier(context: ResolutionContext): RegistryResolutionResult | null {
  if (!shouldTryTier(context, 'suffix')) return null;
  const normalized = normalizeName(context.input);
  return buildNonEmptyResult(
    context,
    'suffix',
    [...context.toolNames].filter((name) => normalizeName(name).includes(normalized)),
  );
}

function shouldTryTier(context: ResolutionContext, tier: ResolutionTier): boolean {
  return context.restrictedTiers ? context.restrictedTiers.includes(tier) : true;
}

function buildNonEmptyResult(
  context: ResolutionContext,
  tier: ResolutionTier,
  candidates: string[],
): RegistryResolutionResult | null {
  return candidates.length ? buildResult(context, tier, candidates) : null;
}

function buildResult(
  context: ResolutionContext,
  tier: ResolutionTier,
  candidates: string[],
): RegistryResolutionResult {
  const filtered = filterDeprecated(candidates, context.allTools, context.allowDeprecated);
  if (!filtered.length) return { resolved: null, tier };
  if (filtered.length > 1) return { resolved: null, tier, ambiguous: filtered };
  const resolved = filtered[0]!;
  emitResolution(context, resolved, tier);
  return { resolved, tier };
}

function emitResolution(
  context: ResolutionContext,
  resolvedName: string,
  tier: ResolutionTier,
): void {
  context.dispatchEvent?.(
    new ToolboxNameResolvedEvent({ originalName: context.input, resolvedName, tier }),
  );
}
