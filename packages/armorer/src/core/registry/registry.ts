import {
  formatToolId,
  normalizeIdentity,
  parseToolId,
  type ToolId,
  type ToolIdentity,
  type ToolIdentityInput,
} from '../identity';
import type { AnyToolDefinition as ToolDefinition } from '../tool-definition';
import { comparePrerelease, compareSemver } from './version-comparison';

export type VersionSelector = (definitions: ToolDefinition[]) => ToolDefinition | undefined;

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
  resolve: (identity: ToolIdentityInput, options?: ResolveOptions) => ToolDefinition | undefined;
  list: () => ToolDefinition[];
  tools: () => ToolDefinition[];
  aliases: (id: ToolId | ToolIdentityInput) => ToolId[];
  getDeprecatedTools: () => ToolDefinition[];
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
      .toSorted((a, b) => a.order - b.order)
      .map((entry) => entry.tool);

  const tools = () => list();

  const register = (definition: ToolDefinition, registerOptions: RegisterOptions = {}) => {
    const normalized = normalizeDefinition(definition);
    const id = normalized.id;
    ensureCanRegister(id, entries, registerOptions);
    if (entries.has(id)) unregister(id);

    const entry: RegistryEntry = { tool: normalized, order: order++, aliases: new Set() };
    entries.set(id, entry);
    addNameIndex(byName, normalized.identity, id);
    registerAliases(entry, id, registerOptions, entries, aliasLookup);
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

  const resolve = (identityInput: ToolIdentityInput, resolveOptions: ResolveOptions = {}) => {
    const identity = normalizeIdentity(identityInput);
    const direct = resolveDirectTool(identity, entries, aliasLookup, maxAliasDepth, resolveOptions);
    if (direct || identity.version) return direct;

    const candidates = selectCandidates(identity, byName, entries, resolveOptions);
    return selectResolvedCandidate(candidates, options.versionSelector);
  };

  const aliases = (idInput: ToolId | ToolIdentityInput) => {
    const id = normalizeIdInput(idInput, { requireVersionForIdentity: false });
    const entry = entries.get(id);
    if (!entry) return [];
    return Array.from(entry.aliases.values());
  };

  const getDeprecatedTools = (): ToolDefinition[] =>
    list().filter((tool) => !!tool.lifecycle?.deprecated);

  return {
    register,
    unregister,
    get,
    resolve,
    list,
    tools,
    aliases,
    getDeprecatedTools,
  };
}

function ensureCanRegister(
  id: ToolId,
  entries: Map<ToolId, RegistryEntry>,
  options: RegisterOptions,
): void {
  if (entries.has(id) && !options.override) throw new Error(`Tool already registered: ${id}`);
}

function addNameIndex(byName: Map<string, ToolId[]>, identity: ToolIdentity, id: ToolId): void {
  const nameKey = nameKeyFromIdentity(identity);
  const listForName = byName.get(nameKey) ?? [];
  listForName.push(id);
  byName.set(nameKey, listForName);
}

function registerAliases(
  entry: RegistryEntry,
  id: ToolId,
  options: RegisterOptions,
  entries: Map<ToolId, RegistryEntry>,
  aliasLookup: Map<ToolId, ToolId>,
): void {
  for (const alias of options.aliases ?? [])
    registerAlias(entry, id, alias, options, entries, aliasLookup);
}

function registerAlias(
  entry: RegistryEntry,
  id: ToolId,
  alias: ToolId,
  options: RegisterOptions,
  entries: Map<ToolId, RegistryEntry>,
  aliasLookup: Map<ToolId, ToolId>,
): void {
  const normalizedAlias = normalizeAlias(alias);
  if (normalizedAlias === id) return;
  const existingTarget = aliasLookup.get(normalizedAlias);
  if (existingTarget && existingTarget !== id)
    handleAliasConflict(normalizedAlias, existingTarget, options, entries);
  aliasLookup.set(normalizedAlias, id);
  entry.aliases.add(normalizedAlias);
}

function handleAliasConflict(
  alias: ToolId,
  existingTarget: ToolId,
  options: RegisterOptions,
  entries: Map<ToolId, RegistryEntry>,
): void {
  if (!options.override) throw new Error(`Alias already registered: ${alias}`);
  entries.get(existingTarget)?.aliases.delete(alias);
}

function resolveDirectTool(
  identity: ToolIdentity,
  entries: Map<ToolId, RegistryEntry>,
  aliasLookup: Map<ToolId, ToolId>,
  maxAliasDepth: number,
  options: ResolveOptions,
): ToolDefinition | undefined {
  const baseId = formatToolId(identity);
  const resolvedId = resolveAlias(baseId, aliasLookup, maxAliasDepth) ?? baseId;
  const tool = entries.get(resolvedId)?.tool;
  return allowDeprecated(tool, options) ? tool : undefined;
}

function selectResolvedCandidate(
  candidates: RegistryEntry[],
  versionSelector: VersionSelector | undefined,
): ToolDefinition | undefined {
  if (!candidates.length) return undefined;
  const selected = versionSelector?.(candidates.map((entry) => entry.tool));
  if (selected) return selected;
  return candidates.every((entry) => isSemver(entry.tool.identity.version))
    ? selectHighestSemver(candidates)
    : selectNewestRegistered(candidates);
}

function selectHighestSemver(candidates: RegistryEntry[]): ToolDefinition | undefined {
  const sorted = candidates.toSorted((a, b) =>
    compareSemver(a.tool.identity.version ?? '', b.tool.identity.version ?? ''),
  );
  return sorted[0]?.tool;
}

function selectNewestRegistered(candidates: RegistryEntry[]): ToolDefinition | undefined {
  const ordered = candidates.toSorted((a, b) => a.order - b.order);
  return ordered.at(-1)?.tool;
}

function normalizeDefinition(definition: ToolDefinition): ToolDefinition {
  const identity = normalizeIdentity(definition.identity);
  const id = formatToolId(identity);
  if (
    definition.id === id &&
    definition.identity.namespace === identity.namespace &&
    definition.identity.name === identity.name &&
    definition.identity.version === identity.version
  ) {
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

function allowDeprecated(tool: ToolDefinition | undefined, options: ResolveOptions): boolean {
  if (!tool) return false;
  if (options.allowDeprecated) return true;
  return !tool.lifecycle?.deprecated;
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
    if (!options.allowDeprecated && !!entry.tool.lifecycle?.deprecated) {
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

export const internalRegistryModuleTestUtilities = {
  comparePrerelease,
};
