import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createProcessLocalApprovalStateStore, type ApprovalStateStore } from './approval-binding';
import {
  approvalResolutionSecret as approvalSecret,
  createApprovalResolutionMapStore,
  createApprovalResolutionRequestContext as createRequestContext,
  approvalResolutionOwnerId as ownerId,
  requireApprovalAction,
  requireSignedApproval,
} from './approval-resolution-test-helpers';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import { createToolResultCache, withToolboxIdempotency } from './idempotency';
import type { ToolApprovalAction, ToolApprovalResolution } from './types';

describe('approval resolution foundation metadata', () => {
  it('emits required approval metadata defaults with a stable idempotency key', async () => {
    const tool = createTool({
      name: 'approval-defaults',
      version: '1.0.0',
      description: 'Approval metadata default test tool',
      input: z.object({ target: z.string() }),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve deploy' }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: createProcessLocalApprovalStateStore(),
      policyRevision: 'policy:test-defaults',
    });
    const requestContext = createRequestContext();
    const call = createToolCall(tool.name, { target: 'production' }, 'approval-defaults-call');

    const first = await toolbox.execute(call, { ownerId, requestContext });
    const second = await toolbox.execute(call, { ownerId, requestContext });
    const firstAction = requireApprovalAction(first.action);
    const secondAction = requireApprovalAction(second.action);

    expect(firstAction).toEqual({
      type: 'approval',
      message: 'Approve deploy',
      risk: 'high',
      operation: { kind: 'other', argsPreview: { target: 'production' } },
      policyVersion: 'policy:test-defaults',
      idempotencyKey: firstAction.idempotencyKey,
    });
    expect(firstAction.idempotencyKey).toStartWith('approval:');
    expect(secondAction).toEqual(firstAction);
  });

  it('uses the policy:1 fallback and separates otherwise identical registry and tool pause keys', async () => {
    const tool = createTool({
      name: 'approval-tier-separation',
      version: '1.0.0',
      description: 'Approval tier key separation test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval',
          reason: 'Approve operation',
          action: { message: 'Approve operation' },
        }),
      },
      execute: async () => 'completed',
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      policy: {
        beforeExecute: () => ({
          status: 'needs_approval',
          reason: 'Approve operation',
          action: { message: 'Approve operation' },
        }),
      },
    });
    const requestContext = createRequestContext();
    const registryPaused = await toolbox.execute(createToolCall(tool.name, {}, 'same-pause-call'), {
      ownerId,
      requestContext,
    });
    const toolPaused = await toolbox.resumeApproval(requireSignedApproval(registryPaused), {
      requestContext,
    });
    const registryAction = requireApprovalAction(registryPaused.action);
    const toolAction = requireApprovalAction(toolPaused.action);

    expect(registryAction.policyVersion).toBe('policy:1');
    expect(toolAction.policyVersion).toBe('policy:1');
    expect(registryAction.idempotencyKey).not.toBe(toolAction.idempotencyKey);
    expect(toolPaused.pendingApproval?.satisfiedPolicyPauses).toEqual([
      { action: registryAction, reason: 'Approve operation', tier: 'registry' },
    ]);
  });

  it('separates approval keys for otherwise identical tool definition revisions', async () => {
    function createVersionedTool(version: string) {
      return createTool({
        name: 'approval-revision-separation',
        version,
        description: 'Approval revision key separation test tool',
        input: z.object({}),
        policy: {
          beforeExecute: () => ({
            status: 'needs_approval',
            reason: 'Approve operation',
            action: { message: 'Approve operation' },
          }),
        },
        execute: async () => 'completed',
      });
    }
    const firstToolbox = createToolbox([createVersionedTool('1.0.0')], { approvalSecret });
    const secondToolbox = createToolbox([createVersionedTool('2.0.0')], { approvalSecret });
    const requestContext = createRequestContext();
    const call = createToolCall('approval-revision-separation', {}, 'same-revision-call');

    const firstPaused = await firstToolbox.execute(call, { ownerId, requestContext });
    const secondPaused = await secondToolbox.execute(call, { ownerId, requestContext });

    expect(requireApprovalAction(firstPaused.action).idempotencyKey).not.toBe(
      requireApprovalAction(secondPaused.action).idempotencyKey,
    );
  });

  it('preserves explicit approval metadata supplied by policy decisions', async () => {
    const expectedAction = {
      type: 'approval',
      message: 'Run command?',
      risk: 'medium',
      operation: {
        kind: 'command',
        command: 'deploy production',
        filesTouched: ['scripts/deploy.ts'],
        argsPreview: { environment: 'production' },
      },
      sandbox: { provider: 'codex', name: 'approval', workingDir: '/workspace' },
      env: ['NODE_ENV'],
      snapshotId: 'snapshot-1',
      expiresAt: '2026-09-19T12:34:56-06:00',
      editableArgs: true,
      policyVersion: 'policy:explicit',
      idempotencyKey: 'approval:explicit-key',
    } satisfies ToolApprovalAction;
    const { type: _type, ...action } = expectedAction;
    const tool = createTool({
      name: 'approval-explicit',
      version: '1.0.0',
      description: 'Approval explicit metadata test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve', action }) },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], { approvalSecret });

    const result = await toolbox.execute(createToolCall(tool.name, {}, 'approval-explicit-call'), {
      ownerId,
      requestContext: createRequestContext(),
    });

    expect(requireApprovalAction(result.action)).toEqual(expectedAction);
  });

  it('approves edited arguments through the resume path', async () => {
    let executedValue: string | undefined;
    const tool = createTool({
      name: 'approval-edits',
      version: '1.0.0',
      description: 'Approval edit resolution test tool',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: ({ params }) => {
          const value = (params as { value?: string }).value;
          return value === 'edited'
            ? { status: 'allow' }
            : { status: 'needs_approval', reason: 'Approve edit' };
        },
      },
      execute: async ({ value }) => {
        executedValue = value;
        return value;
      },
    });
    const toolbox = createToolbox([tool], {
      approvalSecret,
      approvalStateStore: createProcessLocalApprovalStateStore(),
    });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(
      createToolCall(tool.name, { value: 'original' }, 'edit-call'),
      { ownerId, requestContext },
    );

    const resolved = await toolbox.resolveApproval(
      requireSignedApproval(parked),
      { decision: 'approve_with_edits', editedArgs: { value: 'edited' }, remember: false },
      { requestContext },
    );

    expect(resolved.outcome).toBe('success');
    expect(resolved.result).toBe('edited');
    expect(executedValue).toBe('edited');
  });

  it('keeps destructured resolveApproval bound to the idempotency proxy receiver', async () => {
    let callbackCount = 0;
    const tool = createTool({
      name: 'approval-proxy',
      version: '1.0.0',
      description: 'Approval proxy binding test tool',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: ({ params }) => {
          const value = (params as { value?: string }).value;
          return value === 'approved'
            ? { status: 'allow' }
            : { status: 'needs_approval', reason: 'Approve proxy' };
        },
      },
      idempotencyKey: (input: unknown) => `proxy:${(input as { value: string }).value}`,
      execute: async ({ value }) => {
        callbackCount += 1;
        return value;
      },
    });
    const toolbox = createToolbox([tool], { approvalSecret });
    const wrapped = withToolboxIdempotency(toolbox, {
      cache: createToolResultCache({ store: createApprovalResolutionMapStore() }),
      tenantId: 'approval-resolution-tenant',
    });
    const requestContext = createRequestContext();
    const parked = await wrapped.execute(
      createToolCall(tool.name, { value: 'parked' }, 'proxy-call'),
      { ownerId, requestContext },
    );
    const { resolveApproval } = wrapped;

    const resolved = await resolveApproval(
      requireSignedApproval(parked),
      { decision: 'approve_with_edits', editedArgs: { value: 'approved' }, remember: false },
      { requestContext },
    );

    expect(resolved.outcome).toBe('success');
    expect(callbackCount).toBe(1);
    expect(resolved.idempotency?.outcome).toBe('fresh');
  });

  it.each(['approve', 'approve_with_edits', 'deny', 'cancel'] as const)(
    'rejects signed input actions before dispatching %s as an approval resolution',
    async (decision) => {
      let executedCount = 0;
      let firstPolicyCheck = true;
      const innerStore = createProcessLocalApprovalStateStore();
      const approvalStateCounts = { reserve: 0, revoke: 0, consume: 0, commit: 0 };
      const approvalStateStore: ApprovalStateStore = {
        ...innerStore,
        async reserve(binding, context, validationTime) {
          approvalStateCounts.reserve += 1;
          await innerStore.reserve(binding, context, validationTime);
        },
        async revoke(binding) {
          approvalStateCounts.revoke += 1;
          await innerStore.revoke(binding);
        },
        async consume(binding, context, validationTime) {
          approvalStateCounts.consume += 1;
          await innerStore.consume(binding, context, validationTime);
        },
        async commit(binding) {
          approvalStateCounts.commit += 1;
          await innerStore.commit(binding);
        },
      };
      const tool = createTool({
        name: `input-resolution-${decision}`,
        version: '1.0.0',
        description: 'Input action resolution guard test tool',
        input: z.object({ value: z.string() }),
        policy: {
          beforeExecute: () => {
            if (!firstPolicyCheck) return { status: 'allow' };
            firstPolicyCheck = false;
            return {
              status: 'needs_input',
              reason: 'Need input before continuing',
              action: {
                message: 'Provide a value',
                schema: { type: 'object', properties: { value: { type: 'string' } } },
              },
            };
          },
        },
        execute: async ({ value }) => {
          executedCount += 1;
          return value;
        },
      });
      const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore });
      const parked = await toolbox.execute(
        createToolCall(tool.name, { value: 'before' }, `input-resolution-${decision}-call`),
        { ownerId, requestContext: createRequestContext() },
      );
      const signedInputAction = requireSignedApproval(parked);
      expect(signedInputAction.action.type).toBe('input');
      const resolution =
        decision === 'approve_with_edits'
          ? { decision, editedArgs: { value: 'after' }, remember: false }
          : { decision, remember: false };

      await expect(
        toolbox.resolveApproval(signedInputAction, resolution, {
          requestContext: createRequestContext(),
        }),
      ).rejects.toThrow('Approval resolution requires an approval action.');

      expect(executedCount).toBe(0);
      expect(approvalStateCounts).toEqual({ reserve: 0, revoke: 0, consume: 0, commit: 0 });

      const continuedValue = decision === 'approve_with_edits' ? 'after' : 'continued';
      const resumed = await toolbox.resumeApproval(signedInputAction, {
        requestContext: createRequestContext(),
        arguments: { value: continuedValue },
      });

      expect(resumed.outcome).toBe('success');
      expect(resumed.result).toBe(continuedValue);
      expect(executedCount).toBe(1);
      expect(approvalStateCounts).toEqual({ reserve: 1, revoke: 0, consume: 0, commit: 1 });
    },
  );

  it('exports a structural approval resolution contract', () => {
    const resolution = {
      decision: 'approve_with_edits',
      editedArgs: { environment: 'staging' },
      reason: 'Use staging first',
      remember: true,
    } satisfies ToolApprovalResolution;

    expect(resolution).toEqual({
      decision: 'approve_with_edits',
      editedArgs: { environment: 'staging' },
      reason: 'Use staging first',
      remember: true,
    });
  });
});
