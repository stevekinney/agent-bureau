import {
  hasMemoryCapability,
  holdsGovernanceAuthority,
  type MemoryAuthority,
  type MemoryOperation,
} from './authority';

export type MemoryVisibility = 'private' | 'shared';
export type MemoryRecordState = 'active' | 'quarantined' | 'revoked';

/**
 * The persisted facts about a record that decide access. Every one of them is
 * read from the record's governance envelope; nothing a caller supplies with
 * the request (a namespace string, a record id) appears here.
 */
export interface MemoryResourceDescriptor {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly visibility: MemoryVisibility;
  readonly state: MemoryRecordState;
  /** Owners explicitly granted `get` on a private record. */
  readonly sharedWith: readonly string[];
  /** Whether the stored content still matches the digest recorded at admission. */
  readonly integrity: 'intact' | 'tampered';
  /** A derived record its derivation has not yet confirmed against its sources. */
  readonly pendingDerivation: boolean;
}

export type MemoryDenialReason =
  | 'missing-capability'
  | 'tenant-mismatch'
  | 'not-owner'
  | 'not-active'
  | 'not-private'
  | 'shared-write-requires-promotion'
  | 'tampered'
  | 'pending-derivation';

/**
 * `standard` strips governance metadata and protected diagnostics from anything
 * returned; `privileged` (held only with `memory:inspect`) returns them.
 */
export type MemoryRedaction = 'standard' | 'privileged';

export type MemoryAccessDecision =
  | { readonly allowed: true; readonly redaction: MemoryRedaction }
  | { readonly allowed: false; readonly reason: MemoryDenialReason };

const READ_OPERATIONS: ReadonlySet<MemoryOperation> = new Set(['list', 'get', 'search', 'export']);
const CONTROL_OPERATIONS: ReadonlySet<MemoryOperation> = new Set([
  'quarantine',
  'revoke',
  'delete',
]);

function deny(reason: MemoryDenialReason): MemoryAccessDecision {
  return { allowed: false, reason };
}

function ownershipDenial(
  authority: MemoryAuthority,
  operation: MemoryOperation,
  resource: MemoryResourceDescriptor,
): MemoryDenialReason | undefined {
  const isOwner = authority.ownerId === resource.ownerId;
  if (READ_OPERATIONS.has(operation)) {
    if (resource.visibility === 'shared' || isOwner) return undefined;
    const grantee = operation === 'get' && resource.sharedWith.includes(authority.ownerId);
    return grantee ? undefined : 'not-owner';
  }
  if (CONTROL_OPERATIONS.has(operation)) {
    return isOwner || holdsGovernanceAuthority(authority) ? undefined : 'not-owner';
  }
  if (operation === 'write' && resource.visibility === 'shared') {
    return 'shared-write-requires-promotion';
  }
  if (resource.visibility === 'shared') return 'not-private';
  return isOwner ? undefined : 'not-owner';
}

/**
 * The single resource predicate and redaction decision for governed memory.
 * Bureau, Agent, child, tool, A2A, MCP, audit, and administrative projections
 * all call this one function with the same inputs, so none of them can be more
 * permissive than another: the authority's `projection` is recorded for
 * attribution but is never consulted here. A derived record still awaiting
 * its source check is denied to everyone, privileged or not: until its
 * derivation activates it, it may be a copy of content its owner has already
 * deleted or revoked.
 */
export function decideMemoryAccess(
  authority: MemoryAuthority,
  operation: MemoryOperation,
  resource: MemoryResourceDescriptor,
): MemoryAccessDecision {
  if (!hasMemoryCapability(authority, `memory:${operation}`)) return deny('missing-capability');
  if (authority.tenantId !== resource.tenantId) return deny('tenant-mismatch');
  if (resource.pendingDerivation) return deny('pending-derivation');
  const privileged = hasMemoryCapability(authority, 'memory:inspect');
  if (resource.integrity === 'tampered' && !privileged) return deny('tampered');
  const ownership = ownershipDenial(authority, operation, resource);
  if (ownership !== undefined) return deny(ownership);
  if (resource.state !== 'active' && !CONTROL_OPERATIONS.has(operation)) {
    const inspecting = privileged && READ_OPERATIONS.has(operation);
    if (!inspecting) return deny('not-active');
  }
  return { allowed: true, redaction: privileged ? 'privileged' : 'standard' };
}
