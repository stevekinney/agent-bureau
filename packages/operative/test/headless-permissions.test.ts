import { createHeadlessPermissionPolicyHooks, createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type { ToolPolicyDeniedBubbleEvent } from '../src/events';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';

const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

const readFileTool = createTool({
  name: 'read_file',
  description: 'Reads a file',
  input: z.object({ path: z.string() }),
  metadata: { readOnly: true },
  execute: async ({ path }) => ({ content: `contents of ${path}` }),
});

const shellTool = createTool({
  name: 'shell',
  description: 'Runs an arbitrary shell command',
  input: z.object({ command: z.string() }),
  metadata: { dangerous: true },
  execute: async ({ command }) => ({ output: `ran: ${command}` }),
});

const writeFileTool = createTool({
  name: 'write_file',
  description: 'Writes a file',
  input: z.object({ path: z.string(), content: z.string() }),
  metadata: { mutates: true },
  execute: async ({ path }) => ({ written: path }),
});

/**
 * AB-94 — headless deny-by-default permission mode, exercised through a real
 * operative run loop (not just the armorer toolbox in isolation), because the
 * whole point of the preset is "the run never parks on a human." Parking
 * shows up as `action_required`/`pendingApproval`, which only exists at the
 * loop level.
 */
describe('headless deny-by-default permission mode (AB-94)', () => {
  it('denies an unlisted tool call and continues the run to a normal completion', async () => {
    const toolbox = createToolbox([shellTool, readFileTool], {
      policy: createHeadlessPermissionPolicyHooks({ allowList: ['read_file'] }),
    });
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'shell', arguments: { command: 'rm -rf /' } }]),
      textResponse('That command was blocked, so I did not run it.'),
    ]);

    const result = await run({ generate, toolbox, conversation, stopWhen: noToolCalls() });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('That command was blocked, so I did not run it.');
    expect(result.steps).toHaveLength(2);

    const deniedResult = result.steps[0].results[0];
    expect(deniedResult.outcome).toBe('error');
    expect(deniedResult.error?.code).toBe('POLICY_DENIED');
  });

  it('emits a typed tool.policy-denied audit event with the tool name and reason', async () => {
    const toolbox = createToolbox([shellTool, readFileTool], {
      policy: createHeadlessPermissionPolicyHooks({ allowList: ['read_file'] }),
    });
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'shell', arguments: { command: 'rm -rf /' } }]),
      textResponse('Blocked.'),
    ]);

    const activeRun = createActiveRun({ generate, toolbox, conversation, stopWhen: noToolCalls() });
    const denials: ToolPolicyDeniedBubbleEvent[] = [];
    activeRun.addEventListener('tool.policy-denied', (event) => {
      denials.push(event);
    });

    await activeRun.result;

    expect(denials).toHaveLength(1);
    expect(denials[0].toolName).toBe('shell');
    expect(denials[0].reason).toContain('shell');
    expect(denials[0].reason).toContain('allowlist');
  });

  it('denies a synchronous gate check on a path-traversal input and continues the run', async () => {
    const toolbox = createToolbox([readFileTool], {
      policy: createHeadlessPermissionPolicyHooks({
        allowList: ['read_file'],
        gate: (toolName, input) => {
          const path = (input as { path?: string }).path;
          if (toolName === 'read_file' && typeof path === 'string' && path.startsWith('..')) {
            return { allow: false, reason: `Path "${path}" escapes the jail root` };
          }
          return { allow: true };
        },
      }),
    });
    const conversation = new Conversation();

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'read_file', arguments: { path: '../../etc/passwd' } }]),
      textResponse('That path was outside the sandbox, so I could not read it.'),
    ]);

    const result = await run({ generate, toolbox, conversation, stopWhen: noToolCalls() });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    const deniedResult = result.steps[0].results[0];
    expect(deniedResult.outcome).toBe('error');
    expect(deniedResult.errorMessage).toContain('escapes the jail root');
  });

  it('applies deny > ask > allow precedence: a denylisted tool is denied even when also allowlisted', async () => {
    const toolbox = createToolbox([readFileTool], {
      policy: createHeadlessPermissionPolicyHooks({
        allowList: ['read_file'],
        denyList: ['read_file'],
      }),
    });
    const result = await toolbox.execute({
      id: 'call-1',
      name: 'read_file',
      arguments: { path: 'src/index.ts' },
    });
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.errorMessage).toContain('deny list');
  });

  it('NEUTER: without headless ask->deny resolution, the same mutating call would park the run on needs_approval instead of denying and continuing', async () => {
    // The "neutered" comparison uses the tier-only approvalPolicy (no
    // headless resolution) to show what the run does WITHOUT the fix this
    // ticket adds: the run parks (`action_required`) rather than completing.
    const neuteredToolbox = createToolbox([writeFileTool], {
      approvalPolicy: { mode: 'on-mutation' },
    });
    const conversation = new Conversation();
    const generate = createMockGenerate([
      toolCallResponse([
        { name: 'write_file', arguments: { path: 'notes.txt', content: 'hello' } },
      ]),
      textResponse('unreachable if parked'),
    ]);

    const neuteredResult = await run({
      generate,
      toolbox: neuteredToolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    // Parking manifests as an action_required tool outcome rather than the
    // tool-error outcome the headless preset produces.
    expect(neuteredResult.steps[0].results[0].outcome).toBe('action_required');

    // Now the actual headless preset: same tool, same tier config, denies
    // instead of parking, and the run reaches normal completion.
    const headlessToolbox = createToolbox([writeFileTool], {
      policy: createHeadlessPermissionPolicyHooks({
        allowList: ['write_file'],
        capability: { mode: 'on-mutation' },
      }),
    });
    const headlessConversation = new Conversation();
    const headlessGenerate = createMockGenerate([
      toolCallResponse([
        { name: 'write_file', arguments: { path: 'notes.txt', content: 'hello' } },
      ]),
      textResponse('The write was denied, so I stopped there.'),
    ]);

    const headlessResult = await run({
      generate: headlessGenerate,
      toolbox: headlessToolbox,
      conversation: headlessConversation,
      stopWhen: noToolCalls(),
    });

    expect(headlessResult.finishReason).toBe('stop-condition');
    expect(headlessResult.steps[0].results[0].outcome).toBe('error');
    expect(headlessResult.content).toBe('The write was denied, so I stopped there.');
  });
});
