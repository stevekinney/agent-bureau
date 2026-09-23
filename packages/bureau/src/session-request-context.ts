import type { JSONValue } from '@lostgradient/operative';
import type { ToolRequestContext } from 'armorer';

import { isPlainAuthorityRecord } from './session-authority';

export function normalizeRunRequestContext(
  requestContext: ToolRequestContext | undefined,
  runId: string,
  sessionId: string,
  agentName: string,
  principal: string | undefined,
): ToolRequestContext {
  const context = requestContext ?? {
    authority: {
      principalId: principal ?? `run:${runId}`,
      tenantId: 'bureau',
      ownerId: agentName,
      capabilities: ['tools:execute'],
      authorizationRevision: 'bureau:1',
    },
  };
  const authority = Object.freeze({
    ...context.authority,
    capabilities: Object.freeze([...context.authority.capabilities]),
  });
  return Object.freeze({
    ...context,
    authority,
    audience: context.audience ?? 'operator',
    agentId: agentName,
    runId,
    // Reusable approval grant `session` scope (AB-364) matches on this —
    // always the run's OWNING session, never caller-suppliable via
    // `requestContext`, so a request can never forge its way into a
    // different session's grants.
    sessionId,
  });
}

function readRunAuthorityCandidate(metadata: Record<string, JSONValue>, runId: string) {
  const authorities = metadata['lastRequestAuthorities'];
  return isPlainAuthorityRecord(authorities)
    ? authorities[runId]
    : metadata['lastRequestAuthority'];
}

function readPersistedAuthority(
  value: Record<string, JSONValue>,
): ToolRequestContext['authority'] | undefined {
  const capabilities = value['capabilities'];
  if (
    typeof value['principalId'] !== 'string' ||
    typeof value['tenantId'] !== 'string' ||
    typeof value['ownerId'] !== 'string' ||
    typeof value['authorizationRevision'] !== 'string' ||
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string')
  )
    return undefined;
  return {
    principalId: value['principalId'],
    tenantId: value['tenantId'],
    ownerId: value['ownerId'],
    capabilities,
    authorizationRevision: value['authorizationRevision'],
  };
}

function isPersistedAudience(
  value: JSONValue | undefined,
): value is ToolRequestContext['audience'] {
  return value === undefined || value === 'public' || value === 'tenant' || value === 'operator';
}

function isCurrentDeadline(
  value: JSONValue | undefined,
  now: () => number,
): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && !(value <= now()))
  );
}

export function recoveredRequestContextFromMetadata(
  metadata: Record<string, JSONValue>,
  runId: string,
  sessionId: string,
  agentName: string,
  now: () => number,
): ToolRequestContext | undefined {
  const candidate = readRunAuthorityCandidate(metadata, runId);
  if (!isPlainAuthorityRecord(candidate)) return undefined;
  const authority = readPersistedAuthority(candidate);
  const persistedAgentId = candidate['agentId'];
  const deadline = candidate['deadline'];
  const audience = candidate['audience'];
  if (
    !authority ||
    (persistedAgentId !== undefined && typeof persistedAgentId !== 'string') ||
    !isPersistedAudience(audience) ||
    !isCurrentDeadline(deadline, now)
  )
    return undefined;
  return normalizeRunRequestContext(
    {
      authority,
      ...(audience === undefined ? {} : { audience }),
      ...(deadline === undefined ? {} : { deadline }),
    },
    runId,
    sessionId,
    persistedAgentId ?? agentName,
    undefined,
  );
}
