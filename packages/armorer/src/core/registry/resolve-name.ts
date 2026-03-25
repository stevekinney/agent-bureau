import { ToolboxNameResolvedEvent } from '../../events';
import type { ToolRegistry } from './registry';

/**
 * Represents a tier in the name resolution hierarchy.
 * Resolution is attempted in order: exact → case-insensitive → normalized → suffix.
 */
export type ResolutionTier = 'exact' | 'case-insensitive' | 'normalized' | 'suffix';

/**
 * Result of attempting to resolve a tool name.
 */
export type ResolutionResult = {
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
 * Normalizes a tool name for matching.
 * - Lowercases ASCII letters
 * - Replaces underscores, slashes, and dots with hyphens
 * - Trims whitespace
 * - Is idempotent
 *
 * @param name The name to normalize
 * @returns The normalized name
 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[_./]/g, '-');
}

/**
 * Builds candidate names for matching.
 * This is primarily used for testing normalization behavior.
 * Returns the normalized name and all right-anchored suffixes in order.
 *
 * @param name The name to build candidates for
 * @returns Array of candidates in deterministic order
 */
export function buildNameCandidates(name: string): string[] {
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
): ResolutionResult {
  const allowDeprecated = options?.allowDeprecated ?? false;
  const restrictedTiers = options?.restrictTo;

  // Helper to check if a tier should be tried
  const shouldTryTier = (tier: ResolutionTier): boolean => {
    if (!restrictedTiers) return true;
    return restrictedTiers.includes(tier);
  };

  const allTools = registry.tools();
  const toolNames = new Set(allTools.map((tool) => tool.identity.name));

  // Helper to build result and emit event
  const buildResult = (tier: ResolutionTier, candidates: string[]): ResolutionResult => {
    const filtered = filterDeprecated(candidates, allTools, allowDeprecated);

    if (filtered.length === 0) {
      return { resolved: null, tier };
    }

    if (filtered.length === 1) {
      const resolved = filtered[0]!;
      if (dispatchEvent) {
        dispatchEvent(
          new ToolboxNameResolvedEvent({
            originalName: input,
            resolvedName: resolved,
            tier,
          }),
        );
      }
      return { resolved, tier };
    }

    // Multiple matches: ambiguous
    return { resolved: null, tier, ambiguous: filtered };
  };

  // Tier 1: Exact match (case-sensitive, separator-sensitive)
  if (shouldTryTier('exact')) {
    if (toolNames.has(input)) {
      const result = buildResult('exact', [input]);
      if (result.resolved) return result;
    }
  }

  // Tier 2: Case-insensitive (only lowercase, keep separators)
  if (shouldTryTier('case-insensitive')) {
    const inputLowercased = input.toLowerCase();
    const candidates: string[] = [];

    for (const name of toolNames) {
      if (name.toLowerCase() === inputLowercased) {
        candidates.push(name);
      }
    }

    if (candidates.length > 0) {
      const result = buildResult('case-insensitive', candidates);
      if (result.resolved) return result;
      if (result.ambiguous) return result;
    }
  }

  // Tier 3: Normalized (lowercase + normalize separators)
  if (shouldTryTier('normalized')) {
    const normalized = normalizeName(input);
    const candidates: string[] = [];

    for (const name of toolNames) {
      if (normalizeName(name) === normalized) {
        candidates.push(name);
      }
    }

    if (candidates.length > 0) {
      const result = buildResult('normalized', candidates);
      if (result.resolved) return result;
      if (result.ambiguous) return result;
    }
  }

  // Tier 4: Suffix (substring matching on normalized names)
  if (shouldTryTier('suffix')) {
    const normalized = normalizeName(input);
    const matches: string[] = [];

    for (const name of toolNames) {
      const nameNormalized = normalizeName(name);
      // Check if the input (normalized) appears as a substring in the tool name (normalized)
      if (nameNormalized.includes(normalized)) {
        matches.push(name);
      }
    }

    if (matches.length > 0) {
      const result = buildResult('suffix', matches);
      if (result.resolved) return result;
      if (result.ambiguous) return result;
    }
  }

  // No match found
  return { resolved: null, tier: 'exact' };
}
