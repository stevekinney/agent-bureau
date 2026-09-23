import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createProcessLocalApprovalStateStore } from './approval-binding';
import {
  approvalResolutionSecret as approvalSecret,
  createCountingApprovalStateStore,
  createApprovalResolutionRequestContext as createRequestContext,
  approvalResolutionOwnerId as ownerId,
  requireSignedApproval,
} from './approval-resolution-test-helpers';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';

describe('approval resolution reservations and authority', () => {
  it.each([
    ['deny', 'denied', 'permission', 'The user denied this request.'],
    ['cancel', 'CANCELLED', 'cancelled', 'The user cancelled this request.'],
  ] as const)(
    'reserves then revokes %s resolutions without executing',
    async (decision, code, category, message) => {
      let callbackCount = 0;
      const { store, counts } = createCountingApprovalStateStore();
      const tool = createTool({
        name: `approval-${decision}`,
        version: '1.0.0',
        description: 'Approval rejection test tool',
        input: z.object({}),
        policy: {
          beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve rejection' }),
        },
        execute: async () => {
          callbackCount += 1;
          return 'must not execute';
        },
      });
      const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
      const requestContext = createRequestContext();
      const parked = await toolbox.execute(
        createToolCall(tool.name, {}, `approval-${decision}-call`),
        { ownerId, requestContext },
      );

      const resolved = await toolbox.resolveApproval(
        requireSignedApproval(parked),
        { decision, remember: true, reason: 'because test' },
        { requestContext },
      );

      expect(resolved).toMatchObject({
        outcome: 'error',
        content: message,
        error: {
          code,
          category,
          retryable: false,
          message,
          details: { decision, remember: true, reason: 'because test' },
        },
      });
      expect(callbackCount).toBe(0);
      expect(counts.reserve).toBe(1);
      expect(counts.revoke).toBe(1);
      expect(counts.commit).toBe(0);
    },
  );

  it.each(['deny', 'cancel'] as const)(
    'allows only one duplicate %s resolution to reserve an approval',
    async (decision) => {
      const tool = createTool({
        name: `approval-duplicate-${decision}`,
        version: '1.0.0',
        description: 'Approval duplicate rejection race test tool',
        input: z.object({}),
        policy: {
          beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve duplicate' }),
        },
        execute: async () => 'must not execute',
      });
      const toolbox = createToolbox([tool], {
        approvalSecret,
        approvalStateStore: createProcessLocalApprovalStateStore(),
      });
      const requestContext = createRequestContext();
      const parked = await toolbox.execute(
        createToolCall(tool.name, {}, `duplicate-${decision}-call`),
        { ownerId, requestContext },
      );
      const approval = requireSignedApproval(parked);

      const settled = await Promise.allSettled([
        toolbox.resolveApproval(approval, { decision, remember: false }, { requestContext }),
        toolbox.resolveApproval(approval, { decision, remember: false }, { requestContext }),
      ]);

      expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    },
  );

  it('allows only one approve-versus-deny reservation race winner', async () => {
    const tool = createTool({
      name: 'approval-approve-deny-race',
      version: '1.0.0',
      description: 'Approval approve versus deny race test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve race' }),
      },
      execute: async () => 'approved',
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: createProcessLocalApprovalStateStore(),
    });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(createToolCall(tool.name, {}, 'approve-deny-race-call'), {
      ownerId,
      requestContext,
    });
    const approval = requireSignedApproval(parked);

    const settled = await Promise.allSettled([
      toolbox.resolveApproval(
        approval,
        { decision: 'approve', remember: false },
        { requestContext },
      ),
      toolbox.resolveApproval(approval, { decision: 'deny', remember: false }, { requestContext }),
    ]);

    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
  });

  it('rejects stale approval authority before returning a denied result', async () => {
    const { store, counts } = createCountingApprovalStateStore();
    const tool = createTool({
      name: 'approval-stale-authority',
      version: '1.0.0',
      description: 'Approval stale authority test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve stale' }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const parked = await toolbox.execute(createToolCall(tool.name, {}, 'stale-call'), {
      ownerId,
      requestContext: createRequestContext(),
    });

    await expect(
      toolbox.resolveApproval(
        requireSignedApproval(parked),
        { decision: 'deny', remember: false },
        {
          requestContext: createRequestContext({
            authority: {
              principalId: ownerId,
              tenantId: 'approval-resolution-tenant',
              ownerId,
              capabilities: [],
              authorizationRevision: 'stale',
            },
          }),
        },
      ),
    ).rejects.toThrow('authorizationRevision');
    expect(counts.revoke).toBe(0);
  });

  it.each([
    [
      'principalId',
      createRequestContext({
        authority: {
          principalId: 'other-principal',
          tenantId: 'approval-resolution-tenant',
          ownerId,
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
    ],
    [
      'tenantId',
      createRequestContext({
        authority: {
          principalId: ownerId,
          tenantId: 'other-tenant',
          ownerId,
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
    ],
    [
      'ownerId',
      createRequestContext({
        authority: {
          principalId: ownerId,
          tenantId: 'approval-resolution-tenant',
          ownerId: 'other-owner',
          capabilities: [],
          authorizationRevision: '1',
        },
      }),
    ],
    [
      'capabilitiesRevision',
      createRequestContext({
        authority: {
          principalId: ownerId,
          tenantId: 'approval-resolution-tenant',
          ownerId,
          capabilities: ['extra-capability'],
          authorizationRevision: '1',
        },
      }),
    ],
    ['audience', createRequestContext({ audience: 'operator' })],
    ['agentId', createRequestContext({ agentId: 'other-agent' })],
    ['runId', createRequestContext({ runId: 'other-run' })],
  ] as const)('rejects cross-authority %s resolution attempts', async (field, requestContext) => {
    const { store, counts } = createCountingApprovalStateStore();
    const tool = createTool({
      name: `approval-cross-authority-${field}`,
      version: '1.0.0',
      description: 'Approval cross authority test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve stale' }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const parked = await toolbox.execute(createToolCall(tool.name, {}, `cross-${field}-call`), {
      ownerId,
      requestContext: createRequestContext(),
    });

    await expect(
      toolbox.resolveApproval(
        requireSignedApproval(parked),
        { decision: 'deny', remember: false },
        { requestContext },
      ),
    ).rejects.toThrow(field);
    expect(counts.revoke).toBe(0);
  });

  it('rejects stale tool definition revisions before resolving denial', async () => {
    function createVersionedTool(version: string) {
      return createTool({
        name: 'approval-stale-tool-revision',
        version,
        description: 'Approval stale tool revision test tool',
        input: z.object({}),
        policy: {
          beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve stale revision' }),
        },
        execute: async () => 'must not execute',
      });
    }
    const { store, counts } = createCountingApprovalStateStore();
    const requestContext = createRequestContext();
    const original = createToolbox([createVersionedTool('1.0.0')], {
      approvalSecret,
      approvalStateStore: store,
    });
    const changed = createToolbox([createVersionedTool('2.0.0')], {
      approvalSecret,
      approvalStateStore: store,
    });
    const parked = await original.execute(
      createToolCall('approval-stale-tool-revision', {}, 'stale-tool-revision-call'),
      { ownerId, requestContext },
    );

    await expect(
      changed.resolveApproval(
        requireSignedApproval(parked),
        { decision: 'deny', remember: false },
        { requestContext },
      ),
    ).rejects.toThrow('toolDefinitionRevision');
    expect(counts.revoke).toBe(0);
  });

  it.each([
    ['toolboxRevision', { toolboxRevision: 'toolbox:2' }],
    ['policyRevision', { policyRevision: 'policy:2' }],
    ['approvalRevision', { approvalRevision: 'approval:2' }],
  ] as const)('rejects stale %s before resolving denial', async (field, options) => {
    const { store, counts } = createCountingApprovalStateStore();
    const requestContext = createRequestContext();
    const tool = createTool({
      name: `approval-stale-${field}`,
      version: '1.0.0',
      description: 'Approval stale resolver revision test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve stale revision' }),
      },
      execute: async () => 'must not execute',
    });
    const original = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: store,
      toolboxRevision: 'toolbox:1',
      policyRevision: 'policy:1',
      approvalRevision: 'approval:1',
    });
    const changed = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: store,
      toolboxRevision: 'toolbox:1',
      policyRevision: 'policy:1',
      approvalRevision: 'approval:1',
      ...options,
    });
    const parked = await original.execute(createToolCall(tool.name, {}, `stale-${field}-call`), {
      ownerId,
      requestContext,
    });

    await expect(
      changed.resolveApproval(
        requireSignedApproval(parked),
        { decision: 'deny', remember: false },
        { requestContext },
      ),
    ).rejects.toThrow(field);
    expect(counts.revoke).toBe(0);
  });

  it('rejects expired signed approval bindings before resolving denial', async () => {
    let now = 1_000;
    const { store, counts } = createCountingApprovalStateStore(() => now);
    const tool = createTool({
      name: 'approval-expired-resolution',
      version: '1.0.0',
      description: 'Approval expired resolution test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve expiry' }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: store,
      approvalNow: () => now,
    });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(createToolCall(tool.name, {}, 'expired-resolution-call'), {
      ownerId,
      requestContext,
    });
    const approval = requireSignedApproval(parked);
    now = approval.approvalBinding!.expiresAt;

    await expect(
      toolbox.resolveApproval(approval, { decision: 'deny', remember: false }, { requestContext }),
    ).rejects.toThrow('expired');
    expect(counts.revoke).toBe(0);
  });
});
