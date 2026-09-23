import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  approvalResolutionSecret as approvalSecret,
  createCountingApprovalStateStore,
  createDeferredReserveRevokeApprovalStateStore,
  createDeferredStateApprovalStateStore,
  createApprovalResolutionRequestContext as createRequestContext,
  approvalResolutionOwnerId as ownerId,
  requireSignedApproval,
} from './approval-resolution-test-helpers';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import type { SignedPendingToolApproval, ToolApprovalResolution } from './types';

describe('approval resolution mutable caller boundaries', () => {
  it('uses verified approval and resolution snapshots when denial inputs mutate across awaits', async () => {
    const { store, reserve, revoke } = createDeferredReserveRevokeApprovalStateStore();
    const tool = createTool({
      name: 'approval-denial-snapshot',
      version: '1.0.0',
      description: 'Approval denial snapshot test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve denial snapshot' }),
      },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(createToolCall(tool.name, {}, 'denial-snapshot-call'), {
      ownerId,
      requestContext,
    });
    const approval = requireSignedApproval(parked);
    const resolution: ToolApprovalResolution = {
      decision: 'deny',
      remember: true,
      reason: 'original reason',
    };

    const pending = toolbox.resolveApproval(approval, resolution, { requestContext });
    await reserve.started.promise;
    approval.callId = 'mutated-call';
    approval.toolName = 'mutated-tool';
    approval.reason = 'mutated approval reason';
    resolution.decision = 'cancel';
    resolution.remember = false;
    resolution.reason = 'mutated resolution reason';
    reserve.release.resolve();
    await revoke.started.promise;
    approval.callId = 'mutated-again';
    resolution.reason = 'mutated after revoke started';
    revoke.release.resolve();

    const resolved = await pending;

    expect(resolved).toMatchObject({
      callId: 'denial-snapshot-call',
      toolCallId: 'denial-snapshot-call',
      toolName: 'approval-denial-snapshot',
      error: {
        code: 'denied',
        category: 'permission',
        details: { decision: 'deny', remember: true, reason: 'original reason' },
      },
    });
  });

  it('uses the verified approval snapshot when direct resume inputs mutate across awaits', async () => {
    const { store, state } = createDeferredStateApprovalStateStore();
    const tool = createTool({
      name: 'approval-resume-snapshot',
      version: '1.0.0',
      description: 'Approval resume snapshot test tool',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve resume snapshot' }),
      },
      execute: async ({ value }) => value,
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(
      createToolCall(tool.name, { value: 'original' }, 'resume-snapshot-call'),
      { ownerId, requestContext },
    );
    const approval = requireSignedApproval(parked);

    const pending = toolbox.resumeApproval(approval, { requestContext });
    await state.started.promise;
    approval.callId = 'mutated-call';
    approval.toolName = 'mutated-tool';
    approval.reason = 'mutated reason';
    (approval.arguments as { value: string }).value = 'mutated';
    state.release.resolve();

    const resumed = await pending;

    expect(resumed).toMatchObject({
      outcome: 'success',
      toolCallId: 'resume-snapshot-call',
      toolName: 'approval-resume-snapshot',
      result: 'original',
    });
  });

  it('snapshots approve_with_edits arguments before resume awaits', async () => {
    const { store, state } = createDeferredStateApprovalStateStore();
    const tool = createTool({
      name: 'approval-edited-snapshot',
      version: '1.0.0',
      description: 'Approval edited argument snapshot test tool',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: ({ params }) => {
          const value = (params as { value?: string }).value;
          return value === 'edited'
            ? { status: 'allow' }
            : { status: 'needs_approval', reason: 'Approve edited snapshot' };
        },
      },
      execute: async ({ value }) => value,
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(
      createToolCall(tool.name, { value: 'original' }, 'edited-snapshot-call'),
      { ownerId, requestContext },
    );
    const resolution: ToolApprovalResolution = {
      decision: 'approve_with_edits',
      editedArgs: { value: 'edited' },
      remember: false,
    };

    const pending = toolbox.resolveApproval(requireSignedApproval(parked), resolution, {
      requestContext,
    });
    await state.started.promise;
    (resolution.editedArgs as { value: string }).value = 'mutated';
    state.release.resolve();

    const resumed = await pending;

    expect(resumed).toMatchObject({
      outcome: 'success',
      toolCallId: 'edited-snapshot-call',
      toolName: 'approval-edited-snapshot',
      result: 'edited',
    });
  });

  it('rejects resolveApproval option arguments before they can override approved arguments', async () => {
    const { store, counts } = createCountingApprovalStateStore();
    let executedValue: string | undefined;
    const tool = createTool({
      name: 'approval-resolve-options-arguments',
      version: '1.0.0',
      description: 'Approval resolve options argument injection test tool',
      input: z.object({ value: z.string() }),
      policy: {
        beforeExecute: ({ params }) => {
          const value = (params as { value?: string }).value;
          return value === 'injected'
            ? { status: 'allow' }
            : { status: 'needs_approval', reason: 'Approve original arguments' };
        },
      },
      execute: async ({ value }) => {
        executedValue = value;
        return value;
      },
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(
      createToolCall(tool.name, { value: 'original' }, 'resolve-options-arguments-call'),
      { ownerId, requestContext },
    );
    const options = {
      requestContext,
      arguments: { value: 'injected' },
    } as unknown as Parameters<typeof toolbox.resolveApproval>[2];

    await expect(
      toolbox.resolveApproval(
        requireSignedApproval(parked),
        { decision: 'approve', remember: false },
        options,
      ),
    ).rejects.toThrow('Approval resolution options cannot include arguments');
    expect(executedValue).toBeUndefined();
    expect(counts.reserve).toBe(0);
    expect(counts.commit).toBe(0);
    expect(counts.revoke).toBe(0);
  });

  it('validates and uses one resolution snapshot when resolution accessors change', async () => {
    const { store, reserve, revoke } = createDeferredReserveRevokeApprovalStateStore();
    const tool = createTool({
      name: 'approval-resolution-accessor-snapshot',
      version: '1.0.0',
      description: 'Approval resolution accessor snapshot test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve accessor snapshot' }),
      },
      execute: async () => 'must not execute',
    });
    const toolbox = createToolbox([tool], { approvalSecret, approvalStateStore: store });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(
      createToolCall(tool.name, {}, 'resolution-accessor-call'),
      {
        ownerId,
        requestContext,
      },
    );
    let decisionReads = 0;
    let rememberReads = 0;
    let reasonReads = 0;
    const resolution = {
      get decision() {
        decisionReads += 1;
        return decisionReads === 1 ? 'deny' : 'cancel';
      },
      get remember() {
        rememberReads += 1;
        return rememberReads === 1;
      },
      get reason() {
        reasonReads += 1;
        return reasonReads === 1 ? 'original accessor reason' : 'mutated accessor reason';
      },
    } as ToolApprovalResolution;

    const pending = toolbox.resolveApproval(requireSignedApproval(parked), resolution, {
      requestContext,
    });
    await reserve.started.promise;
    reserve.release.resolve();
    await revoke.started.promise;
    revoke.release.resolve();

    const resolved = await pending;

    expect(resolved).toMatchObject({
      error: {
        code: 'denied',
        category: 'permission',
        details: { decision: 'deny', remember: true, reason: 'original accessor reason' },
      },
    });
    expect(decisionReads).toBe(1);
    expect(rememberReads).toBe(1);
    expect(reasonReads).toBe(1);
  });

  it('verifies the exact signed approval snapshot used for resume execution', async () => {
    const tool = createTool({
      name: 'approval-accessor-snapshot',
      version: '1.0.0',
      description: 'Approval accessor snapshot test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve accessor snapshot' }),
      },
      execute: async () => 'approved',
    });
    const toolbox = createToolbox([tool], { approvalSecret });
    const requestContext = createRequestContext();
    const parked = await toolbox.execute(createToolCall(tool.name, {}, 'accessor-snapshot-call'), {
      ownerId,
      requestContext,
    });
    const approval = requireSignedApproval(parked);
    let callIdReads = 0;
    const unstableApproval = { ...approval } as SignedPendingToolApproval;
    Object.defineProperty(unstableApproval, 'callId', {
      enumerable: true,
      configurable: true,
      get() {
        callIdReads += 1;
        return callIdReads === 1 ? 'accessor-snapshot-call' : 'mutated-call';
      },
    });

    const resumed = await toolbox.resumeApproval(unstableApproval, { requestContext });

    expect(resumed).toMatchObject({
      outcome: 'success',
      toolCallId: 'accessor-snapshot-call',
      result: 'approved',
    });
  });
});
