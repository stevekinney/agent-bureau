import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import { ToolSettledEvent } from './tool-lifecycle-events';
import { ToolboxSettledEvent } from './toolbox-lifecycle-events';
import type { SignedPendingToolApproval } from './types';

const ownerId = 'approval-test-owner';

describe('approval settlement contract', () => {
  it('preserves ToolSettledEvent constructor defaults and accepts paused', async () => {
    const tool = createTool({
      name: 'constructor-defaults',
      description: 'Settlement constructor test tool',
      input: z.object({}),
      execute: async () => 'ok',
    });
    let emitted: ToolSettledEvent | undefined;
    tool.addEventListener('settled', (event) => {
      emitted = event;
    });
    const call = createToolCall(tool.name, {});
    await tool.execute(call, { ownerId });
    if (!emitted) throw new Error('missing settled event');
    expect(
      new ToolSettledEvent({ toolCall: emitted.toolCall, configuration: emitted.configuration })
        .status,
    ).toBe('success');
    expect(
      new ToolSettledEvent({
        toolCall: emitted.toolCall,
        configuration: emitted.configuration,
        status: 'paused',
      }).status,
    ).toBe('paused');
    expect(
      new ToolSettledEvent({
        toolCall: emitted.toolCall,
        configuration: emitted.configuration,
        error: new Error('failed'),
      }).status,
    ).toBe('error');
  });
  it.each([
    ['needs_approval', 'Approval required'],
    ['needs_input', 'Input required'],
  ] as const)('settles %s exactly once without invoking the callback', async (status, reason) => {
    let callbackCount = 0;
    const tool = createTool({
      name: `approval-${status}`,
      description: 'Approval settlement test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ status, reason }) },
      execute: async () => {
        callbackCount += 1;
        return 'must not execute';
      },
    });
    const call = createToolCall(tool.name, {}, `call-${status}`);
    const events: string[] = [];
    const starts: Array<{ executionId?: string | undefined; ownerId?: string | undefined }> = [];
    const settlements: Array<{
      executionId?: string | undefined;
      ownerId?: string | undefined;
      callId: string;
      status?: string | undefined;
      callbackCompletion?: Promise<unknown> | undefined;
    }> = [];
    tool.addEventListener('execute-start', (event) => {
      events.push(event.type);
      starts.push({ executionId: event.executionId, ownerId: event.ownerId });
    });
    tool.addEventListener('policy-action-required', (event) => {
      events.push(event.type);
    });
    tool.addEventListener('settled', (event) => {
      events.push(event.type);
      settlements.push({
        executionId: event.executionId,
        ownerId: event.ownerId,
        callId: event.toolCall.id,
        status: event.status,
        callbackCompletion: event.callbackCompletion,
      });
    });

    const result = await tool.execute(call, { executionId: `execution-${status}`, ownerId });

    expect(result.outcome).toBe('action_required');
    expect(result.pendingApproval).toMatchObject({
      callId: call.id,
      toolName: tool.name,
      arguments: {},
      action: { type: status === 'needs_approval' ? 'approval' : 'input' },
      reason,
    });
    expect(callbackCount).toBe(0);
    expect(events).toEqual(['execute-start', 'policy-action-required', 'settled']);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.callId).toBe(call.id);
    expect(settlements[0]?.executionId).toBe(starts[0]?.executionId);
    expect(settlements[0]?.executionId).toBeTruthy();
    expect(settlements[0]?.ownerId).toBe(ownerId);
    expect(settlements[0]?.status).toBe('paused');
    const callbackCompletion = settlements[0]?.callbackCompletion;
    expect(callbackCompletion).toBeInstanceOf(Promise);
    if (!(callbackCompletion instanceof Promise)) throw new Error('missing callback completion');
    await callbackCompletion;
  });

  it.each(['needs_approval', 'needs_input'] as const)(
    'keeps direct and toolbox %s settlement identities aligned',
    async (gateStatus) => {
      const tool = createTool({
        name: 'toolbox-approval',
        description: 'Toolbox approval settlement test tool',
        input: z.object({}),
        policy: { beforeExecute: () => ({ status: gateStatus, reason: 'Approve this call' }) },
        execute: async () => 'must not execute',
      });
      const toolbox = createToolbox([tool]);
      const registeredTool = toolbox.tools()[0]!;
      const call = createToolCall(tool.name, {}, 'toolbox-call');
      expect(new ToolboxSettledEvent({ tool: registeredTool, call }).status).toBe('success');
      expect(
        new ToolboxSettledEvent({ tool: registeredTool, call, error: new Error('failed') }).status,
      ).toBe('error');
      expect(new ToolboxSettledEvent({ tool: registeredTool, call, status: 'paused' }).status).toBe(
        'paused',
      );
      const directStarts: string[] = [];
      const directSettlements: string[] = [];
      const directStatuses: string[] = [];
      const starts: Array<{ executionId?: string | undefined; ownerId?: string | undefined }> = [];
      const settlements: Array<{
        callId: string;
        executionId?: string | undefined;
        ownerId?: string | undefined;
        status?: string | undefined;
      }> = [];
      toolbox.addEventListener('execute-start', (event) => {
        starts.push({ executionId: event.executionId, ownerId: event.ownerId });
      });
      toolbox.addEventListener('settled', (event) => {
        settlements.push({
          callId: event.call.id,
          executionId: event.executionId,
          ownerId: event.ownerId,
          status: event.status,
        });
      });
      registeredTool.addEventListener('execute-start', (event) => {
        directStarts.push(event.executionId ?? '');
      });
      registeredTool.addEventListener('settled', (event) => {
        directSettlements.push(event.executionId ?? '');
        directStatuses.push(event.status);
      });

      const result = await toolbox.execute(call, { ownerId });

      expect(result.outcome).toBe('action_required');
      expect(settlements).toHaveLength(1);
      expect(settlements[0]?.callId).toBe(call.id);
      expect(settlements[0]?.executionId).toBe(starts[0]?.executionId);
      expect(settlements[0]?.executionId).toBeTruthy();
      expect(settlements[0]?.ownerId).toBe(ownerId);
      expect(settlements[0]?.status).toBe('paused');
      expect(directStatuses).toEqual(['paused']);
      const executionId = starts[0]?.executionId;
      const settlementExecutionId = settlements[0]?.executionId;
      if (!executionId || !settlementExecutionId) throw new Error('missing execution identity');
      expect(directStarts).toEqual([executionId]);
      expect(directSettlements).toEqual([settlementExecutionId]);
    },
  );

  it('settles an approved resume once for the parked and resumed invocations', async () => {
    let callbackCount = 0;
    const tool = createTool({
      name: 'resumable-approval',
      version: '1.0.0',
      description: 'Resumable approval settlement test tool',
      input: z.object({ value: z.string() }),
      policy: { beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve this call' }) },
      execute: async ({ value }) => {
        callbackCount += 1;
        return value;
      },
    });
    const toolbox = createToolbox([tool], { approvalSecret: 'approval-test-secret' });
    const requestContext = {
      authority: {
        principalId: ownerId,
        tenantId: 'approval-tenant',
        ownerId,
        capabilities: [],
        authorizationRevision: '1',
      },
      audience: 'tenant' as const,
      agentId: 'approval-agent',
      runId: 'approval-run',
    };
    const call = createToolCall(tool.name, { value: 'approved' }, 'resume-call');
    const starts: string[] = [];
    const settlements: Array<{ executionId: string; status?: string; callId: string }> = [];
    toolbox.addEventListener('execute-start', (event) => {
      starts.push(event.executionId ?? '');
    });
    toolbox.addEventListener('settled', (event) => {
      settlements.push({
        executionId: event.executionId ?? '',
        status: event.status,
        callId: event.call.id,
      });
    });

    const parked = await toolbox.execute(call, { ownerId, requestContext });
    expect(parked.outcome).toBe('action_required');
    expect(parked.pendingApproval).toMatchObject({
      callId: call.id,
      toolName: tool.name,
      arguments: { value: 'approved' },
      action: { type: 'approval' },
      reason: 'Approve this call',
    });
    const pendingApproval = parked.pendingApproval;
    if (!pendingApproval?.approvalToken) throw new Error('missing signed pending approval');
    const signedPendingApproval = pendingApproval as SignedPendingToolApproval;
    const resumed = await toolbox.resumeApproval(signedPendingApproval, { requestContext });

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('approved');
    expect(callbackCount).toBe(1);
    expect(starts).toHaveLength(2);
    expect(settlements).toHaveLength(2);
    expect(starts[0]).not.toBe(starts[1]);
    expect(settlements.map(({ executionId }) => executionId)).toEqual(starts);
    expect(settlements.map(({ status }) => status)).toEqual(['paused', 'success']);
    expect(settlements.every(({ callId }) => callId === call.id)).toBe(true);
  });

  it('settles policy denial with the existing permission error and no callback', async () => {
    let callbackCount = 0;
    const tool = createTool({
      name: 'denied-tool',
      description: 'Denied settlement test tool',
      input: z.object({}),
      policy: { beforeExecute: () => ({ allow: false, reason: 'Denied by policy' }) },
      execute: async () => {
        callbackCount += 1;
        return 'must not execute';
      },
    });
    const events: string[] = [];
    let settlement: { callbackCompletion?: Promise<unknown> | undefined } | undefined;
    tool.addEventListener('execute-start', (event) => {
      events.push(event.type);
    });
    tool.addEventListener('policy-denied', (event) => {
      events.push(event.type);
    });
    tool.addEventListener('execute-error', (event) => {
      events.push(event.type);
    });
    tool.addEventListener('settled', (event) => {
      events.push(event.type);
      settlement = event;
    });

    const result = await tool.execute(createToolCall(tool.name, {}), { ownerId });

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(callbackCount).toBe(0);
    expect(events).toEqual(['execute-start', 'policy-denied', 'execute-error', 'settled']);
    const callbackCompletion = settlement?.callbackCompletion;
    expect(callbackCompletion).toBeInstanceOf(Promise);
    if (!(callbackCompletion instanceof Promise)) throw new Error('missing callback completion');
    await callbackCompletion;
  });

  it('settles cancellation after execute-start while policy evaluation is waiting', async () => {
    let callbackCount = 0;
    const entered = Promise.withResolvers<void>();
    const barrier = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const controller = new AbortController();
    const events: string[] = [];
    let callbackCompletion: Promise<unknown> | undefined;
    const tool = createTool({
      name: 'cancelled-tool',
      description: 'Cancellation settlement test tool',
      input: z.object({}),
      policy: {
        beforeExecute: async () => {
          entered.resolve();
          queueMicrotask(() => {
            controller.abort('cancelled by test');
            cancelled.resolve();
          });
          await barrier.promise;
          return { allow: true };
        },
      },
      execute: async () => {
        callbackCount += 1;
        return 'must not execute';
      },
    });
    tool.addEventListener('execute-start', () => {
      events.push('execute-start');
    });
    tool.addEventListener('execute-error', () => {
      events.push('execute-error');
    });
    tool.addEventListener('settled', (event) => {
      events.push('settled');
      callbackCompletion = event.callbackCompletion;
    });

    const execution = tool.execute(createToolCall(tool.name, {}), {
      ownerId,
      signal: controller.signal,
    });
    await entered.promise;
    await cancelled.promise;
    expect(callbackCount).toBe(0);
    barrier.resolve();
    const result = await execution;

    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('CANCELLED');
    expect(events).toEqual(['execute-start', 'execute-error', 'settled']);
    expect(callbackCount).toBe(0);
    expect(callbackCompletion).toBeInstanceOf(Promise);
    await callbackCompletion;
    expect(tool.executions.inspect({ ownerId })).toMatchObject([{ state: 'terminal' }]);
  });

  it('keeps action_required settlement when afterExecute reports a plain error', async () => {
    let callbackCount = 0;
    const events: string[] = [];
    const logs: Array<{ level?: string; message?: string }> = [];
    let settlement: { callbackCompletion?: Promise<unknown> | undefined } | undefined;
    const tool = createTool({
      name: 'after-hook-approval',
      description: 'Approval after-hook settlement test tool',
      input: z.object({}),
      policy: {
        beforeExecute: () => ({ status: 'needs_approval', reason: 'Approve this call' }),
        afterExecute: () => {
          throw new Error('after hook failed');
        },
      },
      execute: async () => {
        callbackCount += 1;
        return 'must not execute';
      },
    });
    tool.addEventListener('execute-start', (event) => {
      events.push(event.type);
    });
    tool.addEventListener('policy-action-required', (event) => {
      events.push(event.type);
    });
    tool.addEventListener('log', (event) => {
      logs.push({ level: event.level, message: event.message });
    });
    tool.addEventListener('settled', (event) => {
      events.push(event.type);
      settlement = event;
    });

    const result = await tool.execute(createToolCall(tool.name, {}), { ownerId });

    expect(result.outcome).toBe('action_required');
    expect(result.pendingApproval).toMatchObject({
      callId: result.toolCallId,
      toolName: tool.name,
      arguments: {},
      action: { type: 'approval' },
      reason: 'Approve this call',
    });
    expect(callbackCount).toBe(0);
    expect(events).toEqual(['execute-start', 'policy-action-required', 'settled']);
    expect(logs).toContainEqual({ level: 'warn', message: 'policy afterExecute failed' });
    const callbackCompletion = settlement?.callbackCompletion;
    expect(callbackCompletion).toBeInstanceOf(Promise);
    if (!(callbackCompletion instanceof Promise)) throw new Error('missing callback completion');
    await callbackCompletion;
  });
});
