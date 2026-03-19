export type ResolutionTier = 'exact' | 'case-insensitive' | 'normalized' | 'suffix';

export type ResolutionResult =
  | { resolved: string; tier: ResolutionTier }
  | { resolved: null; ambiguous?: string[] };

export function normalizeName(name: string): string {
  // Lowercase, replace . / _ with -, trim whitespace. Idempotent.
  return name.toLowerCase().replace(/[./_]/g, '-').trim();
}

export function resolveCaseInsensitive(name: string, toolNames: string[]): string | null {
  // Lowercase comparison. If exactly one match, return it. If 0 or multiple, return null.
  const lower = name.toLowerCase();
  const matches = toolNames.filter((n) => n.toLowerCase() === lower);
  return matches.length === 1 ? matches[0]! : null;
}

export function buildNameCandidates(name: string): string[] {
  // Returns [normalized, ...suffix candidates]
  // Suffix = last segment after splitting on . / _ -
  const normalized = normalizeName(name);
  const candidates = [normalized];

  // Extract suffix (last segment)
  const segments = name.split(/[./_-]/);
  if (segments.length > 1) {
    const suffix = segments[segments.length - 1]!.toLowerCase();
    if (suffix && suffix !== normalized) {
      candidates.push(suffix);
    }
  }

  return candidates;
}

export function resolveFuzzyToolName(name: string, toolNames: string[]): ResolutionResult {
  if (!name) return { resolved: null };

  // Tier 1: Exact match
  if (toolNames.includes(name)) {
    return { resolved: name, tier: 'exact' };
  }

  // Tier 2: Case-insensitive
  const caseMatch = resolveCaseInsensitive(name, toolNames);
  if (caseMatch) {
    return { resolved: caseMatch, tier: 'case-insensitive' };
  }
  // Check for ambiguous case-insensitive
  const lower = name.toLowerCase();
  const caseMatches = toolNames.filter((n) => n.toLowerCase() === lower);
  if (caseMatches.length > 1) {
    return { resolved: null, ambiguous: caseMatches };
  }

  // Tier 3: Normalized (dot/slash/underscore → hyphen)
  const normalized = normalizeName(name);
  const normalizedMatches = toolNames.filter((n) => normalizeName(n) === normalized);
  if (normalizedMatches.length === 1) {
    return { resolved: normalizedMatches[0]!, tier: 'normalized' };
  }
  if (normalizedMatches.length > 1) {
    return { resolved: null, ambiguous: normalizedMatches };
  }

  // Tier 4: Suffix matching (last segment)
  const segments = name.split(/[./_-]/);
  if (segments.length > 1) {
    const suffix = segments[segments.length - 1]!.toLowerCase();
    if (suffix) {
      const suffixMatches = toolNames.filter((n) => {
        const toolSegments = n.split(/[./_-]/);
        return toolSegments[toolSegments.length - 1]?.toLowerCase() === suffix;
      });
      if (suffixMatches.length === 1) {
        return { resolved: suffixMatches[0]!, tier: 'suffix' };
      }
      if (suffixMatches.length > 1) {
        return { resolved: null, ambiguous: suffixMatches };
      }
    }
  }

  return { resolved: null };
}
