import { describe, expect, test } from 'bun:test';

import { toolActionSchema } from './schemas';

describe('tool action schema approval metadata', () => {
  const approvalAction = {
    type: 'approval',
    message: 'Approve deployment?',
    risk: 'high',
    operation: {
      kind: 'command',
      command: 'deploy',
      argsPreview: { environment: 'production' },
    },
    sandbox: {
      provider: 'codex',
      name: 'workspace-write',
      workingDir: '/workspace',
    },
    expiresAt: '2026-09-19T12:34:56-06:00',
    policyVersion: 'policy:1',
    idempotencyKey: 'approval-key',
  } as const;

  test('accepts complete approval metadata', () => {
    const parsed = toolActionSchema.safeParse(approvalAction);

    expect(parsed.success).toBe(true);
  });

  test('rejects missing approval metadata and malformed timestamps', () => {
    expect(toolActionSchema.safeParse({ type: 'approval' }).success).toBe(false);
    expect(
      toolActionSchema.safeParse({
        type: 'approval',
        risk: 'high',
        operation: { kind: 'other' },
        expiresAt: '2026-09-19T12:34:56',
        policyVersion: 'policy:1',
        idempotencyKey: 'approval-key',
      }).success,
    ).toBe(false);
  });

  test('accepts early ISO years with explicit timezones without rewriting bytes', () => {
    for (const expiresAt of ['0099-09-19T12:34:56Z', '0099-09-19T12:34:56+00:00']) {
      const parsed = toolActionSchema.safeParse({ ...approvalAction, expiresAt });

      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.data.type === 'approval') {
        expect(parsed.data.expiresAt).toBe(expiresAt);
      }
    }
  });

  test.each([
    ['top-level approval', { ...approvalAction, unexpected: 'x' }],
    [
      'command operation',
      {
        ...approvalAction,
        operation: { ...approvalAction.operation, unexpected: 'x' },
      },
    ],
    [
      'sandbox',
      {
        ...approvalAction,
        sandbox: { ...approvalAction.sandbox, unexpected: 'x' },
      },
    ],
  ])('rejects unknown %s fields', (_label, action) => {
    expect(toolActionSchema.safeParse(action).success).toBe(false);
  });

  test('keeps approval operation filesTouched exact optional', () => {
    const omitted = toolActionSchema.safeParse(approvalAction);
    const present = toolActionSchema.safeParse({
      ...approvalAction,
      operation: { ...approvalAction.operation, filesTouched: ['deployments/production.json'] },
    });
    const explicitUndefined = toolActionSchema.safeParse({
      ...approvalAction,
      operation: { ...approvalAction.operation, filesTouched: undefined },
    });

    expect(omitted.success).toBe(true);
    expect(present.success).toBe(true);
    expect(explicitUndefined.success).toBe(false);
  });

  test('keeps input actions independent', () => {
    expect(
      toolActionSchema.safeParse({
        type: 'input',
        message: 'Need a value',
        schema: { type: 'object' },
      }).success,
    ).toBe(true);
  });
});
