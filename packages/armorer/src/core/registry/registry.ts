import {
  formatToolId,
  normalizeIdentity,
  parseToolId,
  type ToolId,
  type ToolIdentity,
  type ToolIdentityInput,
} from '../identity';
import type { AnyToolDefinition as ToolDefinition } from '../tool-definition';

export type VersionSelector = (
  definitions: ToolDefinition[],
) => ToolDefinition | undefined;

export type RegistryOptions = {
  versionSelector?: VersionSelector;
  maxAliasDepth?: number;
};

export type RegisterOptions = {
  aliases?: ToolId[];
  override?: boolean;
};

export type ResolveOptions = {
  allowDeprecated?: boolean;
};

export type ToolRegistry = {
  register: (definition: ToolDefinition, options?: RegisterOptions) => ToolDefinition;
  unregister: (id: ToolId | ToolIdentityInput) => boolean;
  get: (id: ToolId | ToolIdentityInput) => ToolDefinition | undefined;
  resolve: (
    identity: ToolIdentityInput,
    options?: ResolveOptions,
  ) => ToolDefinition | undefined;
  list: () => ToolDefinition[];
  tools: () => ToolDefinition[];
  aliases: (id: ToolId | ToolIdentityInput) => ToolId[];
};

type RegistryEntry = {
  tool: ToolDefinition;
  order: number;
  aliases: Set<ToolId>;
};

const DEFAULT_ALIAS_DEPTH = 10;

export function createRegistry(options: RegistryOptions = {}): ToolRegistry {
  const entries = new Map<ToolId, RegistryEntry>();
  const byName = new Map<string, ToolId[]>();
  const aliasLookup = new Map<ToolId, ToolId>();
  let order = 0;

  const maxAliasDepth = options.maxAliasDepth ?? DEFAULT_ALIAS_DEPTH;

  const list = () =>
    Array.from(entries.values())
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.tool);

  const tools = () => list();

  const register = (
    definition: ToolDefinition,
    registerOptions: RegisterOptions = {},
  ) => {
    const normalized = normalizeDefinition(definition);
    const id = normalized.id;

    if (entries.has(id) && !registerOptions.override) {
      throw new Error(`Tool already registered: ${id}`);
    }

    if (entries.has(id) && registerOptions.override) {
      unregister(id);
    }

    const entry: RegistryEntry = {
      tool: normalized,
      order: order++,
      aliases: new Set(),
    };

    entries.set(id, entry);
    const nameKey = nameKeyFromIdentity(normalized.identity);
    const listForName = byName.get(nameKey) ?? [];
    listForName.push(id);
    byName.set(nameKey, listForName);

    const aliases = registerOptions.aliases ?? [];
    for (const alias of aliases) {
      const normalizedAlias = normalizeAlias(alias);
      if (normalizedAlias === id) {
        continue;
      }
      const existingTarget = aliasLookup.get(normalizedAlias);
      if (existingTarget && existingTarget !== id && !registerOptions.override) {
        throw new Error(`Alias already registered: ${normalizedAlias}`);
      }
      if (existingTarget && existingTarget !== id && registerOptions.override) {
        const previousEntry = entries.get(existingTarget);
        previousEntry?.aliases.delete(normalizedAlias);
      }
      aliasLookup.set(normalizedAlias, id);
      entry.aliases.add(normalizedAlias);
    }

    return normalized;
  };

  const unregister = (idInput: ToolId | ToolIdentityInput) => {
    const id = normalizeIdInput(idInput, { requireVersionForIdentity: true });
    const entry = entries.get(id);
    if (!entry) return false;

    entries.delete(id);
    const nameKey = nameKeyFromIdentity(entry.tool.identity);
    const listForName = byName.get(nameKey);
    if (listForName) {
      const next = listForName.filter((stored) => stored !== id);
      if (next.length) {
        byName.set(nameKey, next);
      } else {
        byName.delete(nameKey);
      }
    }

    for (const alias of entry.aliases) {
      aliasLookup.delete(alias);
    }

    return true;
  };

  const get = (idInput: ToolId | ToolIdentityInput) => {
    const id = normalizeIdInput(idInput, { requireVersionForIdentity: true });
    return entries.get(id)?.tool;
  };

  const resolve = (
    identityInput: ToolIdentityInput,
    resolveOptions: ResolveOptions = {},
  ) => {
    const identity = normalizeIdentity(identityInput);
    const baseId = formatToolId(identity);
    const resolvedId = resolveAlias(baseId, aliasLookup, maxAliasDepth);
    if (resolvedId) {
      const tool = entries.get(resolvedId)?.tool;
      return allowDeprecated(tool, resolveOptions) ? tool : undefined;
    }

    if (identity.version) {
      const tool = entries.get(baseId)?.tool;
      return allowDeprecated(tool, resolveOptions) ? tool : undefined;
    }

    const candidates = selectCandidates(identity, byName, entries, resolveOptions);
    if (!candidates.length) return undefined;

    if (options.versionSelector) {
      const selected = options.versionSelector(candidates.map((entry) => entry.tool));
      if (selected) return selected;
    }

    const allSemver = candidates.every((entry) => isSemver(entry.tool.identity.version));
    if (allSemver) {
      const sorted = [...candidates].sort((a, b) =>
        compareSemver(a.tool.identity.version!, b.tool.identity.version!),
      );
      return sorted[0]?.tool;
    }

    const ordered = [...candidates].sort((a, b) => a.order - b.order);
    return ordered[ordered.length - 1]?.tool;
  };

  const aliases = (idInput: ToolId | ToolIdentityInput) => {
    const id = normalizeIdInput(idInput, { requireVersionForIdentity: false });
    const entry = entries.get(id);
    if (!entry) return [];
    return Array.from(entry.aliases.values());
  };

  return {
    register,
    unregister,
    get,
    resolve,
    list,
    tools,
    aliases,
  };
}

function normalizeDefinition(definition: ToolDefinition): ToolDefinition {
  const identity = normalizeIdentity(definition.identity);
  const id = formatToolId(identity);
  if (definition.id === id && definition.identity === identity) {
    return definition;
  }
  return {
    ...definition,
    identity,
    id,
  };
}

function nameKeyFromIdentity(identity: ToolIdentity): string {
  return `${identity.namespace}:${identity.name}`;
}

function normalizeIdInput(
  input: ToolId | ToolIdentityInput,
  options: { requireVersionForIdentity: boolean },
): ToolId {
  if (typeof input === 'string') {
    const parsed = parseToolId(input);
    if (options.requireVersionForIdentity && !parsed.version) {
      throw new Error('Tool identity must include a version for get/unregister');
    }
    return formatToolId(parsed);
  }
  const identity = normalizeIdentity(input);
  if (options.requireVersionForIdentity && !identity.version) {
    throw new Error('Tool identity must include a version for get/unregister');
  }
  return formatToolId(identity);
}

function normalizeAlias(alias: ToolId): ToolId {
  return formatToolId(parseToolId(alias));
}

function resolveAlias(
  id: ToolId,
  aliases: Map<ToolId, ToolId>,
  maxDepth: number,
): ToolId | undefined {
  let current: ToolId | undefined = id;
  const visited = new Set<ToolId>();
  let depth = 0;
  while (current && aliases.has(current)) {
    if (visited.has(current)) {
      throw new Error(`Alias cycle detected at ${current}`);
    }
    if (depth >= maxDepth) {
      throw new Error(`Alias resolution exceeded max depth at ${current}`);
    }
    visited.add(current);
    current = aliases.get(current);
    depth += 1;
  }
  return current !== id ? current : undefined;
}

function allowDeprecated(
  tool: ToolDefinition | undefined,
  options: ResolveOptions,
): boolean {
  if (!tool) return false;
  if (options.allowDeprecated) return true;
  return tool.lifecycle?.deprecated !== true;
}

function selectCandidates(
  identity: ToolIdentity,
  byName: Map<string, ToolId[]>,
  entries: Map<ToolId, RegistryEntry>,
  options: ResolveOptions,
): RegistryEntry[] {
  const key = nameKeyFromIdentity(identity);
  const ids = byName.get(key) ?? [];
  const resolved: RegistryEntry[] = [];
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) continue;
    if (!options.allowDeprecated && entry.tool.lifecycle?.deprecated === true) {
      continue;
    }
    resolved.push(entry);
  }
  return resolved;
}

function isSemver(value: string | undefined): boolean {
  if (!value) return false;
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return 0;

  if (parsedA.major !== parsedB.major) return parsedB.major - parsedA.major;
  if (parsedA.minor !== parsedB.minor) return parsedB.minor - parsedA.minor;
  if (parsedA.patch !== parsedB.patch) return parsedB.patch - parsedA.patch;

  if (!parsedA.prerelease && parsedB.prerelease) return -1;
  if (parsedA.prerelease && !parsedB.prerelease) return 1;
  if (!parsedA.prerelease && !parsedB.prerelease) return 0;

  return comparePrerelease(parsedA.prerelease!, parsedB.prerelease!);
}

function parseSemver(
  value: string,
): { major: number; minor: number; patch: number; prerelease?: string } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value,
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
  };
}

function comparePrerelease(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    const aIsNum = !Number.isNaN(aNum) && aPart.trim() !== '';
    const bIsNum = !Number.isNaN(bNum) && bPart.trim() !== '';
    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return bNum - aNum;
      continue;
    }
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    if (aPart !== bPart) return bPart.localeCompare(aPart);
  }
  return 0;
}
