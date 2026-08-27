import type { JSONValue } from './types';

export interface ToolAuthority {
  readonly principalId: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly capabilities: readonly string[];
  readonly authorizationRevision: string;
}

export interface ToolRequestContext {
  readonly authority: ToolAuthority;
  readonly audience?: 'public' | 'tenant' | 'operator';
  readonly agentId?: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly locale?: string;
  readonly traceContext?: unknown;
  readonly credentials?: unknown;
  readonly deadline?: number;
}

export interface EffectiveToolExecutionContext extends ToolRequestContext {
  readonly revisions: {
    readonly catalog: string;
    readonly toolbox: string;
    readonly toolDefinition: string;
    readonly policy: string;
    readonly approval: string;
    readonly redaction: string;
  };
}

export const EXTERNAL_PROJECTION_VERSION = 1 as const;
export type ExternalFieldClass =
  'public' | 'tenant-private' | 'operator-private' | 'never-exported';
export type ExternalProjectionAudience = 'public' | 'tenant' | 'operator';
export interface ExternalProjectionOptions {
  readonly audience: ExternalProjectionAudience;
  readonly tenantId?: string;
  readonly sourceTenantId?: string;
}

export interface ExternalExecutionProjection {
  version: typeof EXTERNAL_PROJECTION_VERSION;
  audience: ExternalProjectionAudience;
  data: JSONValue;
}

const fieldClasses: Readonly<Record<string, ExternalFieldClass>> = Object.freeze({
  executionId: 'public',
  toolName: 'public',
  callId: 'public',
  revision: 'public',
  state: 'public',
  queuedAt: 'public',
  startedAt: 'public',
  deadline: 'public',
  lastActivityAt: 'public',
  queuePosition: 'public',
  capacity: 'public',
  declaredWait: 'public',
  abortSource: 'public',
  cleanup: 'public',
  status: 'public',
  ownerId: 'tenant-private',
  parentExecutionId: 'tenant-private',
  authority: 'operator-private',
  tenantId: 'tenant-private',
  requestId: 'tenant-private',
  agentId: 'tenant-private',
  runId: 'tenant-private',
  locale: 'tenant-private',
  principalId: 'operator-private',
  authorizationRevision: 'operator-private',
  capabilities: 'operator-private',
  revisions: 'operator-private',
  catalog: 'operator-private',
  toolbox: 'operator-private',
  toolDefinition: 'operator-private',
  policy: 'operator-private',
  approval: 'operator-private',
  redaction: 'operator-private',
  arguments: 'never-exported',
  params: 'never-exported',
  result: 'never-exported',
  error: 'never-exported',
  logs: 'never-exported',
  chunks: 'never-exported',
  credentials: 'never-exported',
  traceContext: 'never-exported',
  providerPayload: 'never-exported',
  abortReason: 'never-exported',
});

export function freezeToolRequestContext(
  context: ToolRequestContext,
): Readonly<ToolRequestContext> {
  return Object.freeze({
    ...context,
    authority: Object.freeze({
      ...context.authority,
      capabilities: Object.freeze([...context.authority.capabilities]),
    }),
  });
}

export function freezeEffectiveToolExecutionContext(
  context: EffectiveToolExecutionContext,
): Readonly<EffectiveToolExecutionContext> {
  return Object.freeze({
    ...freezeToolRequestContext(context),
    revisions: Object.freeze({ ...context.revisions }),
  });
}

export function projectExecutionSnapshot(
  value: unknown,
  options: ExternalProjectionOptions,
): ExternalExecutionProjection {
  if (options.audience === 'tenant') {
    if (!options.tenantId || !options.sourceTenantId) {
      throw new Error('Tenant projection requires tenantId and sourceTenantId');
    }
    if (options.tenantId !== options.sourceTenantId) {
      throw new Error('Tenant projection cannot cross tenant boundaries');
    }
  }
  return Object.freeze({
    version: EXTERNAL_PROJECTION_VERSION,
    audience: options.audience,
    data: redact(value, options, undefined) as JSONValue,
  });
}

/** Full-fidelity operator view; callers must keep this behind an operator gate. */
export function privilegedExecutionSnapshot(
  context: EffectiveToolExecutionContext,
): EffectiveToolExecutionContext {
  return Object.freeze({
    ...context,
    authority: Object.freeze({
      ...context.authority,
      capabilities: Object.freeze([...context.authority.capabilities]),
    }),
    revisions: Object.freeze({ ...context.revisions }),
  });
}

function redact(
  value: unknown,
  options: ExternalProjectionOptions,
  key: string | undefined,
): unknown {
  if (key) {
    const fieldClass = fieldClasses[key] ?? 'never-exported';
    if (fieldClass === 'never-exported') return undefined;
    if (fieldClass === 'tenant-private' && options.audience === 'public') return undefined;
    if (fieldClass === 'operator-private' && options.audience !== 'operator') return undefined;
  }
  if (Array.isArray(value))
    return value
      .map((item) => redact(item, options, undefined))
      .filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [field, child] of Object.entries(value)) {
    const projected = redact(child, options, field);
    if (projected !== undefined) result[field] = projected;
  }
  return result;
}

export function narrowToolAuthority(
  context: ToolRequestContext,
  capabilities: readonly string[],
): ToolRequestContext {
  const allowed = new Set(capabilities);
  return freezeToolRequestContext({
    ...context,
    authority: {
      ...context.authority,
      capabilities: context.authority.capabilities.filter((capability) => allowed.has(capability)),
    },
  });
}
