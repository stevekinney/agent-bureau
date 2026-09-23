import {
  GRANT_VERSION,
  type GrantStateStore,
  type ReusableApprovalGrant,
  verifyGrantSignature,
} from './approval-binding';
import { assertJsonValue, type JsonValue, stableStringifyJson } from './core/serialization/json';
import type { ToolRequestContext } from './execution-context';
import type { ToolPolicyContext } from './is-tool';
import { isRecord, readPolicyRequestContext } from './toolbox-policy-primitives';
function normalizeJsonValue(value: unknown): JsonValue {
  const normalized: unknown = JSON.parse(JSON.stringify(value ?? null));
  assertJsonValue(normalized, 'grant argument constraint');
  return normalized;
}
export async function findMatchingGrant(
  context: ToolPolicyContext,
  grantStateStore: GrantStateStore,
  approvalSecret: string,
  now: number,
  toolboxPolicyRevision: string | undefined,
): Promise<ReusableApprovalGrant | undefined> {
  const requestContext = readPolicyRequestContext(context);
  // Every use reauthorizes principal, tenant, and owner against the request
  // context (AB-46 AC2): absent authority means no grant can ever match,
  // never an implicit approve.
  if (!requestContext) {
    return undefined;
  }
  const { authority } = requestContext;
  const grants = await grantStateStore.list();
  for (const grant of grants) {
    if (
      !matchesGrantRecord(grant, context, authority, requestContext, now, toolboxPolicyRevision)
    ) {
      continue;
    }
    try {
      // The HMAC proves the record is unmodified since the toolbox signed
      // it — it never proves who is asking; that's `authority` above.
      verifyGrantSignature(grant, approvalSecret);
    } catch {
      continue;
    }
    return grant;
  }
  return undefined;
}

function matchesGrantRecord(
  grant: ReusableApprovalGrant,
  context: ToolPolicyContext,
  authority: ToolRequestContext['authority'],
  requestContext: ToolRequestContext,
  now: number,
  toolboxPolicyRevision: string | undefined,
): boolean {
  return (
    isGrantUsable(grant, now, toolboxPolicyRevision) &&
    matchesGrantIdentity(grant, context, authority, requestContext) &&
    matchesGrantArguments(grant, context, requestContext)
  );
}

function isGrantUsable(
  grant: ReusableApprovalGrant,
  now: number,
  toolboxPolicyRevision: string | undefined,
): boolean {
  return (
    grant.version === GRANT_VERSION &&
    !grant.revoked &&
    grant.usesRemaining > 0 &&
    now < grant.expiresAt &&
    grant.policyRevision === toolboxPolicyRevision
  );
}

function matchesGrantIdentity(
  grant: ReusableApprovalGrant,
  context: ToolPolicyContext,
  authority: ToolRequestContext['authority'],
  requestContext: ToolRequestContext,
): boolean {
  return (
    grant.toolName === context.toolName &&
    grant.principalId === authority.principalId &&
    grant.tenantId === authority.tenantId &&
    grant.ownerId === authority.ownerId &&
    (grant.agentId === '*' || grant.agentId === requestContext.agentId)
  );
}

function matchesGrantArguments(
  grant: ReusableApprovalGrant,
  context: ToolPolicyContext,
  requestContext: ToolRequestContext,
): boolean {
  return (
    matchesResourcePattern(grant.resourcePattern, context.params) &&
    matchesArgumentConstraints(grant.argumentConstraints, context.params) &&
    matchesGrantScope(grant, requestContext)
  );
}

/**
 * Enforces `ReusableApprovalGrant.scope` (AB-364): a `run`-scoped grant
 * matches only calls whose request context carries the SAME `runId`; a
 * `session`-scoped grant matches only calls whose request context carries
 * the same `sessionId`; and a `principal`-scoped grant matches as before (no
 * additional identifier check). A `run`/`session` grant missing its own
 * scoping identifier (should never happen — `issueGrant` validates this at
 * mint time — but a persisted grant predating this validation, or one
 * restored from an untrusted store, could still lack it) never matches:
 * comparing two `undefined`s would otherwise let it match every call under
 * the same principal, tenant, owner, agent, and tool, exactly the gap this
 * issue closes.
 */
export function matchesGrantScope(
  grant: ReusableApprovalGrant,
  requestContext: ToolRequestContext,
): boolean {
  if (grant.scope === 'run') {
    return grant.runId !== undefined && grant.runId === requestContext.runId;
  }
  if (grant.scope === 'session') {
    return grant.sessionId !== undefined && grant.sessionId === requestContext.sessionId;
  }
  return true;
}

/**
 * Glob-style match against a caller-declared `resource` field in the tool's
 * arguments (AB-46's `resourcePattern` field comment). `undefined` matches
 * any resource; a pattern present but no string `resource` field in the
 * arguments never matches.
 */
export function matchesResourcePattern(pattern: string | undefined, params: unknown): boolean {
  if (pattern === undefined) {
    return true;
  }
  if (!isRecord(params) || typeof params['resource'] !== 'string') {
    return false;
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(params['resource']);
}

/**
 * `argumentConstraints` is deliberately plain JSON data, not a live Zod
 * schema instance — a `ZodType` embedded in a grant could never survive the
 * `JSON.stringify` round trip `signGrant`'s HMAC payload goes through, so
 * matching is a deep-equal check per declared key against the call's
 * arguments, normalized through the same JSON round trip for a stable
 * comparison.
 */
export function matchesArgumentConstraints(
  constraints: Record<string, unknown> | undefined,
  params: unknown,
): boolean {
  if (constraints === undefined) {
    return true;
  }
  // `createTool`/`createToolbox` only ever accept a Zod OBJECT input schema
  // (enforced at tool-construction time — see `registerConfiguration`'s
  // "Tool input must be a Zod object schema" check), so a validated call's
  // `params` is always a plain record by the time `beforeExecute` runs.
  const record: Record<string, unknown> = isRecord(params) ? params : {};
  return Object.entries(constraints).every(
    ([key, expected]) =>
      stableStringifyJson(normalizeJsonValue(record[key])) ===
      stableStringifyJson(normalizeJsonValue(expected)),
  );
}
