import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool } from '../src/create-tool';
import {
  type EffectiveToolExecutionContext,
  narrowToolAuthority,
  privilegedExecutionSnapshot,
  projectExecutionSnapshot,
} from '../src/execution-context';
import { createExecutionLifecycle } from '../src/execution-lifecycle';

const effectiveContext: EffectiveToolExecutionContext = {
  authority: {
    principalId: 'principal-a',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['read', 'write'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant',
  agentId: 'agent-a',
  runId: 'run-a',
  credentials: { token: 'secret' },
  traceContext: { traceparent: 'secret-trace' },
  revisions: {
    catalog: 'catalog:1',
    toolbox: 'toolbox:1',
    toolDefinition: 'tool:1',
    policy: 'policy:1',
    approval: 'approval:1',
    redaction: 'redaction:1',
  },
};

describe('execution authority and projections', () => {
  it('allows policy to narrow but never expand host capabilities', () => {
    expect(
      narrowToolAuthority(effectiveContext, ['write', 'admin']).authority.capabilities,
    ).toEqual(['write']);
    expect(
      narrowToolAuthority(
        {
          ...effectiveContext,
          authority: { ...effectiveContext.authority, capabilities: ['*'] },
        },
        ['write', 'admin'],
      ).authority.capabilities,
    ).toEqual(['write', 'admin']);
  });

  it('keeps privileged context separate from general lifecycle snapshots', () => {
    const lifecycle = createExecutionLifecycle();
    const handle = lifecycle.begin({
      toolName: 'charge',
      callId: 'call-1',
      privilegedContext: effectiveContext,
    });

    expect(lifecycle.inspect()[0]).not.toHaveProperty('context');
    expect(handle.privilegedSnapshot().context?.credentials).toEqual({ token: 'secret' });
    expect(lifecycle.inspectPrivileged()[0]?.context?.revisions.toolDefinition).toBe('tool:1');
  });

  it('exports a versioned deny-by-default projection and never exports payloads', () => {
    const projection = projectExecutionSnapshot(
      {
        executionId: 'execution-1',
        toolName: 'charge',
        ownerId: 'owner-a',
        tenantId: 'tenant-a',
        result: { card: 'secret' },
        credentials: { token: 'secret' },
        newlyAddedUnclassifiedField: 'must-not-leak',
      },
      { audience: 'tenant', tenantId: 'tenant-a', sourceTenantId: 'tenant-a' },
    );

    expect(projection).toEqual({
      version: 1,
      audience: 'tenant',
      data: {
        executionId: 'execution-1',
        toolName: 'charge',
        ownerId: 'owner-a',
        tenantId: 'tenant-a',
      },
    });
    expect(() =>
      projectExecutionSnapshot(
        { executionId: 'execution-1' },
        { audience: 'tenant', tenantId: 'tenant-b', sourceTenantId: 'tenant-a' },
      ),
    ).toThrow('cross tenant');
    expect(() =>
      projectExecutionSnapshot(
        { executionId: 'execution-1' },
        { audience: 'tenant', tenantId: 'tenant-a' },
      ),
    ).toThrow('requires tenantId and sourceTenantId');

    expect(
      projectExecutionSnapshot([{ executionId: 'execution-1' }, undefined, { result: 'secret' }], {
        audience: 'public',
      }).data,
    ).toEqual([{ executionId: 'execution-1' }, {}]);
  });

  it('rejects unclassified primitive projection roots', () => {
    expect(() => projectExecutionSnapshot('must-not-leak', { audience: 'public' })).toThrow(
      'External projection root must be an object or array',
    );
  });

  it('redacts unclassified primitive array elements while preserving supported snapshots', () => {
    expect(
      projectExecutionSnapshot(
        ['must-not-leak', 123, false, null, { executionId: 'execution-1' }, { result: 'secret' }],
        { audience: 'public' },
      ).data,
    ).toEqual([{ executionId: 'execution-1' }, {}]);
  });

  it('projects privileged lifecycle snapshot containers through deny-by-default redaction', () => {
    const projection = projectExecutionSnapshot(
      {
        snapshot: {
          executionId: 'execution-1',
          toolName: 'charge',
          callId: 'call-1',
          revision: 2,
          state: 'terminal',
          queuedAt: 100,
          lastActivityAt: 200,
          ownerId: 'owner-a',
          result: { card: 'secret' },
          unclassifiedSnapshotField: 'must-not-leak',
        },
        context: effectiveContext,
        unclassifiedContainer: {
          executionId: 'must-not-traverse',
        },
      },
      { audience: 'operator' },
    );

    expect(projection).toEqual({
      version: 1,
      audience: 'operator',
      data: {
        snapshot: {
          executionId: 'execution-1',
          toolName: 'charge',
          callId: 'call-1',
          revision: 2,
          state: 'terminal',
          queuedAt: 100,
          lastActivityAt: 200,
          ownerId: 'owner-a',
        },
        context: {
          authority: {
            principalId: 'principal-a',
            tenantId: 'tenant-a',
            ownerId: 'owner-a',
            capabilities: ['read', 'write'],
            authorizationRevision: 'authorization:1',
          },
          agentId: 'agent-a',
          runId: 'run-a',
          revisions: {
            catalog: 'catalog:1',
            toolbox: 'toolbox:1',
            toolDefinition: 'tool:1',
            policy: 'policy:1',
            approval: 'approval:1',
            redaction: 'redaction:1',
          },
        },
      },
    });
  });

  it('reasserts host identity after policy context injection and narrows runtime authority', async () => {
    let observedContext: unknown;
    const tool = createTool({
      name: 'inspect-authority',
      description: 'Inspect authority',
      input: z.object({}),
      policyContext: () => ({
        requestContext: {
          authority: { principalId: 'attacker', tenantId: 'tenant-b' },
        },
      }),
      policy: {
        beforeExecute() {
          return { allow: true, capabilities: ['read', 'admin'] };
        },
      },
      execute(_input, context) {
        observedContext = context.requestContext;
        return 'ok';
      },
    });

    await tool.execute(
      { id: 'call-1', name: 'inspect-authority', arguments: {} },
      { requestContext: effectiveContext, effectiveContext },
    );

    expect(observedContext).toMatchObject({
      authority: {
        principalId: 'principal-a',
        tenantId: 'tenant-a',
        capabilities: ['read'],
      },
    });
    expect(privilegedExecutionSnapshot(effectiveContext).credentials).toEqual({ token: 'secret' });
  });
});
