import type { ToolRequestContext } from 'armorer';
import { z } from 'zod';

/**
 * The ten governed memory operations. Every projection (Bureau, Agent, child,
 * tool, A2A, MCP, audit, administrative) reaches memory only through one of
 * these, and every one is decided by the same resource predicate.
 */
export const MEMORY_OPERATIONS = [
  'list',
  'get',
  'search',
  'write',
  'promote',
  'share',
  'export',
  'quarantine',
  'revoke',
  'delete',
] as const;
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

/**
 * Capabilities that are not a plain operation: privileged inspection of
 * governance metadata and protected diagnostics, legal-hold placement and
 * release, retention administration (sweeps), and platform policy
 * administration. `memory:policy` activates or rolls back the one governance
 * policy every tenant of an instance runs under, so a host grants it only to its
 * platform's governance principal, never to one tenant's governance.
 */
export const MEMORY_ADMINISTRATIVE_CAPABILITIES = [
  'memory:inspect',
  'memory:legal-hold',
  'memory:retention',
  'memory:policy',
] as const;

export type MemoryCapability =
  `memory:${MemoryOperation}` | (typeof MEMORY_ADMINISTRATIVE_CAPABILITIES)[number];

export const MEMORY_CAPABILITIES: readonly MemoryCapability[] = Object.freeze([
  ...MEMORY_OPERATIONS.map((operation): MemoryCapability => `memory:${operation}`),
  ...MEMORY_ADMINISTRATIVE_CAPABILITIES,
]);

export const MEMORY_PRINCIPAL_KINDS = [
  'user',
  'agent',
  'run',
  'tool',
  'service',
  'governance',
] as const;
export type MemoryPrincipalKind = (typeof MEMORY_PRINCIPAL_KINDS)[number];

/**
 * The surfaces memory is reached through. A projection is recorded on every
 * operation for attribution; it never changes the access decision.
 */
export const MEMORY_PROJECTIONS = [
  'bureau',
  'agent',
  'child',
  'tool',
  'a2a',
  'mcp',
  'audit',
  'administrative',
] as const;
export type MemoryProjection = (typeof MEMORY_PROJECTIONS)[number];

export interface MemoryPrincipal {
  readonly kind: MemoryPrincipalKind;
  readonly id: string;
}

/** One hop of delegated authority: who held it and which capabilities it carried. */
export interface MemoryDelegationLink {
  readonly principal: MemoryPrincipal;
  readonly capabilities: readonly MemoryCapability[];
}

/**
 * The authority every governed memory operation carries. It names the acting
 * principal or service identity, the tenant, the resource owner it acts for, the
 * purpose, its capabilities, the delegation chain those capabilities came
 * through, and the authorization policy revision they were granted under.
 *
 * It deliberately has no namespace: a namespace or record id a caller supplies
 * is only a selector inside the scope this authority already owns, never a
 * credential that widens it.
 */
export interface MemoryAuthority {
  readonly principal: MemoryPrincipal;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly capabilities: readonly MemoryCapability[];
  readonly delegationChain: readonly MemoryDelegationLink[];
  readonly policyRevision: string;
  readonly projection: MemoryProjection;
}

export type MemoryAuthorityErrorCode = 'invalid-authority' | 'escalation';

export class MemoryAuthorityError extends Error {
  readonly code: MemoryAuthorityErrorCode;

  constructor(code: MemoryAuthorityErrorCode, message: string) {
    super(message);
    this.name = 'MemoryAuthorityError';
    this.code = code;
  }
}

const nonEmpty = z.string().min(1);
const principalSchema = z.object({ kind: z.enum(MEMORY_PRINCIPAL_KINDS), id: nonEmpty });
const capabilitySchema = z.enum(MEMORY_CAPABILITIES as [MemoryCapability, ...MemoryCapability[]]);
const linkSchema = z.object({
  principal: principalSchema,
  capabilities: z.array(capabilitySchema),
});
const authoritySchema = z.object({
  principal: principalSchema,
  tenantId: nonEmpty,
  ownerId: nonEmpty,
  purpose: nonEmpty,
  capabilities: z.array(capabilitySchema),
  delegationChain: z.array(linkSchema).min(1),
  policyRevision: nonEmpty,
  projection: z.enum(MEMORY_PROJECTIONS),
});

function isSubset(inner: readonly string[], outer: readonly string[]): boolean {
  const allowed = new Set(outer);
  return inner.every((capability) => allowed.has(capability));
}

function samePrincipal(left: MemoryPrincipal, right: MemoryPrincipal): boolean {
  return left.kind === right.kind && left.id === right.id;
}

/**
 * How much a principal kind can vouch for. A delegation link never names a more
 * privileged kind than the link it inherited from: a user, Agent, run, or tool
 * can never become a service or governance principal, and a service can never
 * become governance.
 */
const PRINCIPAL_PRIVILEGE: Readonly<Record<MemoryPrincipalKind, number>> = {
  user: 0,
  agent: 0,
  run: 0,
  tool: 0,
  service: 1,
  governance: 2,
};

function escalatesKind(parent: MemoryPrincipal, child: MemoryPrincipal): boolean {
  return PRINCIPAL_PRIVILEGE[child.kind] > PRINCIPAL_PRIVILEGE[parent.kind];
}

function freezeLink(link: MemoryDelegationLink): MemoryDelegationLink {
  return Object.freeze({
    principal: Object.freeze({ kind: link.principal.kind, id: link.principal.id }),
    capabilities: Object.freeze([...link.capabilities]),
  });
}

function freezeAuthority(authority: MemoryAuthority): MemoryAuthority {
  return Object.freeze({
    principal: Object.freeze({ kind: authority.principal.kind, id: authority.principal.id }),
    tenantId: authority.tenantId,
    ownerId: authority.ownerId,
    purpose: authority.purpose,
    capabilities: Object.freeze([...authority.capabilities]),
    delegationChain: Object.freeze(authority.delegationChain.map(freezeLink)),
    policyRevision: authority.policyRevision,
    projection: authority.projection,
  });
}

/**
 * Validates an authority and returns a frozen copy. Every malformed field fails
 * closed: an unknown capability (including a wildcard), a chain whose last link
 * is not the acting principal, a link that widens its predecessor's
 * capabilities or names a more privileged principal kind, or effective
 * capabilities the chain never granted are all rejected.
 */
export function assertMemoryAuthority(value: unknown): MemoryAuthority {
  const parsed = authoritySchema.safeParse(value);
  if (!parsed.success) {
    throw new MemoryAuthorityError('invalid-authority', 'Memory authority is malformed.');
  }
  const authority = parsed.data;
  const chain = authority.delegationChain;
  if (!samePrincipal(chain.at(-1)!.principal, authority.principal)) {
    throw new MemoryAuthorityError(
      'invalid-authority',
      'The last delegation link must be the acting principal.',
    );
  }
  for (let index = 1; index < chain.length; index++) {
    if (!isSubset(chain[index]!.capabilities, chain[index - 1]!.capabilities)) {
      throw new MemoryAuthorityError(
        'invalid-authority',
        `Delegation link ${index} widens the authority it inherited.`,
      );
    }
    if (escalatesKind(chain[index - 1]!.principal, chain[index]!.principal)) {
      throw new MemoryAuthorityError(
        'invalid-authority',
        `Delegation link ${index} names a more privileged principal kind than it inherited.`,
      );
    }
  }
  if (!isSubset(authority.capabilities, chain.at(-1)!.capabilities)) {
    throw new MemoryAuthorityError(
      'invalid-authority',
      'Memory authority exceeds its delegation chain.',
    );
  }
  return freezeAuthority(authority);
}

export interface CreateMemoryAuthorityInput {
  readonly principal: MemoryPrincipal;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly capabilities: readonly MemoryCapability[];
  readonly policyRevision: string;
  readonly projection: MemoryProjection;
  /** Links that delegated authority to `principal`, root first. */
  readonly delegatedBy?: readonly MemoryDelegationLink[];
}

/** Builds and validates an authority whose chain ends with `principal`. */
export function createMemoryAuthority(input: CreateMemoryAuthorityInput): MemoryAuthority {
  return assertMemoryAuthority({
    principal: input.principal,
    tenantId: input.tenantId,
    ownerId: input.ownerId,
    purpose: input.purpose,
    capabilities: input.capabilities,
    delegationChain: [
      ...(input.delegatedBy ?? []),
      { principal: input.principal, capabilities: input.capabilities },
    ],
    policyRevision: input.policyRevision,
    projection: input.projection,
  });
}

export interface AttenuateMemoryAuthorityRequest {
  readonly principal: MemoryPrincipal;
  readonly capabilities?: readonly MemoryCapability[];
  readonly purpose?: string;
  readonly projection?: MemoryProjection;
}

/**
 * Derives a child's authority from its parent's. The child inherits tenant,
 * owner, and policy revision unchanged and may only narrow: a request for any
 * capability the parent lacks, or for a more privileged principal kind than the
 * parent's (an Agent claiming to be governance, a user claiming to be a
 * service), is rejected, never clamped.
 */
export function attenuateMemoryAuthority(
  parent: MemoryAuthority,
  request: AttenuateMemoryAuthorityRequest,
): MemoryAuthority {
  const capabilities = request.capabilities ?? parent.capabilities;
  if (!isSubset(capabilities, parent.capabilities)) {
    throw new MemoryAuthorityError(
      'escalation',
      'A delegated memory authority cannot request capabilities its parent does not hold.',
    );
  }
  if (escalatesKind(parent.principal, request.principal)) {
    throw new MemoryAuthorityError(
      'escalation',
      'A delegated memory authority cannot claim a more privileged principal kind than its parent.',
    );
  }
  return assertMemoryAuthority({
    ...parent,
    principal: request.principal,
    capabilities,
    purpose: request.purpose ?? parent.purpose,
    projection: request.projection ?? parent.projection,
    delegationChain: [...parent.delegationChain, { principal: request.principal, capabilities }],
  });
}

export function hasMemoryCapability(
  authority: MemoryAuthority,
  capability: MemoryCapability,
): boolean {
  return authority.capabilities.includes(capability);
}

/** True when any link of the delegation chain (including the actor) has one of `kinds`. */
export function delegationChainIncludes(
  authority: MemoryAuthority,
  kinds: readonly MemoryPrincipalKind[],
): boolean {
  return authority.delegationChain.some((link) => kinds.includes(link.principal.kind));
}

function chainConsistsOf(
  authority: MemoryAuthority,
  kinds: readonly MemoryPrincipalKind[],
): boolean {
  const last = authority.delegationChain.at(-1);
  return (
    last !== undefined &&
    samePrincipal(last.principal, authority.principal) &&
    authority.delegationChain.every((link) => kinds.includes(link.principal.kind))
  );
}

/**
 * Governance privilege — acting on records a principal does not own, legal
 * holds, policy administration — comes from the delegation chain, never from the
 * actor's declared kind: every link, root to actor, must be a governance
 * principal, so no user, Agent, run, tool, or service anywhere upstream lends it.
 */
export function holdsGovernanceAuthority(authority: MemoryAuthority): boolean {
  return chainConsistsOf(authority, ['governance']);
}

/**
 * Service privilege — background retention and system-trusted writes — needs a
 * chain made only of service and governance principals, so nothing a user or a
 * model can reach ever sits upstream of it.
 */
export function holdsServiceAuthority(authority: MemoryAuthority): boolean {
  return chainConsistsOf(authority, ['service', 'governance']);
}

/**
 * The memory principal behind a request authority's `principalId`: a
 * `service:` identity is a service, a `run:` identity (Bureau's default when a
 * request names no principal) is a run, and anything else is a user.
 */
export function requestPrincipal(principalId: string): MemoryPrincipal {
  if (principalId.startsWith('service:')) return { kind: 'service', id: principalId };
  if (principalId.startsWith('run:')) return { kind: 'run', id: principalId };
  return { kind: 'user', id: principalId };
}

export interface MemoryAuthorityFromToolContextOptions {
  /** The principal acting under the request authority, for example the tool itself. */
  readonly principal: MemoryPrincipal;
  readonly purpose: string;
  readonly projection: MemoryProjection;
}

/**
 * Maps an armorer request authority — the persisted, request-scoped authority a
 * tool executes under — onto a memory authority. Only explicit `memory:*`
 * capabilities carry over; a wildcard never grants memory access implicitly.
 */
export function memoryAuthorityFromToolRequestContext(
  context: ToolRequestContext,
  options: MemoryAuthorityFromToolContextOptions,
): MemoryAuthority {
  const known = new Set<string>(MEMORY_CAPABILITIES);
  const capabilities = context.authority.capabilities.filter(
    (capability): capability is MemoryCapability => known.has(capability),
  );
  const requester = requestPrincipal(context.authority.principalId);
  return createMemoryAuthority({
    principal: options.principal,
    tenantId: context.authority.tenantId,
    ownerId: context.authority.ownerId,
    purpose: options.purpose,
    capabilities,
    policyRevision: context.authority.authorizationRevision,
    projection: options.projection,
    delegatedBy: [{ principal: requester, capabilities }],
  });
}
