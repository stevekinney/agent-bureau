import { isAbsolute, normalize, resolve as resolvePath, sep } from 'node:path';

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  type ApprovalMode,
  approvalStatusToDecision,
  type CapabilityTier,
  combineApprovalStatuses,
  createApprovalPolicyHooks,
  createHeadlessPermissionPolicyHooks,
  evaluateApprovalStatus,
  evaluateCapabilityApproval,
  evaluateHeadlessPermission,
  type HeadlessPermissionPolicyConfiguration,
  type PermissionGate,
  resolveApprovalMode,
  resolveCapabilityTier,
} from './approval-policy';
import { createCodingTools } from './coding/index';
import { PathTraversalError } from './coding/jail';
import { createTool, createToolCall } from './create-tool';
import { createToolbox } from './create-toolbox';
import { createToolboxFromOpenAPI, type OpenAPISpec } from './integrations/openapi/index';
import type { ToolMetadata, ToolPolicyContext } from './is-tool';

const TIERS: readonly (CapabilityTier | undefined)[] = [
  'read-only',
  'mutating',
  'dangerous',
  undefined,
];
const MODES: readonly ApprovalMode[] = ['never', 'on-mutation', 'always', 'deny'];

function makeTool(name: string, metadata: ToolMetadata) {
  return createTool({
    name,
    description: `Tool ${name}`,
    input: z.object({}),
    metadata,
    execute: async () => ({ ok: true }),
  });
}

function buildContext(metadata: ToolMetadata): ToolPolicyContext {
  const tool = makeTool('example-tool', metadata);
  return {
    toolName: tool.name,
    toolCall: createToolCall(tool.name, {}),
    params: {},
    configuration: tool.configuration,
    metadata,
  };
}

describe('resolveCapabilityTier', () => {
  it('resolves dangerous over mutating and read-only from metadata', () => {
    expect(resolveCapabilityTier({ dangerous: true, mutates: true, readOnly: false })).toBe(
      'dangerous',
    );
  });

  it('resolves mutating when dangerous is absent', () => {
    expect(resolveCapabilityTier({ mutates: true })).toBe('mutating');
  });

  it('resolves read-only when only readOnly is set', () => {
    expect(resolveCapabilityTier({ readOnly: true })).toBe('read-only');
  });

  it('falls back to risk tags when metadata is absent', () => {
    expect(resolveCapabilityTier(undefined, ['dangerous'])).toBe('dangerous');
    expect(resolveCapabilityTier(undefined, ['mutating'])).toBe('mutating');
    expect(resolveCapabilityTier(undefined, ['readonly'])).toBe('read-only');
  });

  it('returns undefined (unrecognized) when nothing declares a tier', () => {
    expect(resolveCapabilityTier(undefined)).toBeUndefined();
    expect(resolveCapabilityTier({})).toBeUndefined();
  });
});

describe('evaluateApprovalStatus — precedence matrix', () => {
  it('deny mode always denies, regardless of tier', () => {
    for (const tier of TIERS) {
      expect(evaluateApprovalStatus(tier, 'deny')).toBe('deny');
    }
  });

  it('unrecognized tier always escalates to ask, even under mode "never"', () => {
    expect(evaluateApprovalStatus(undefined, 'never')).toBe('ask');
    expect(evaluateApprovalStatus(undefined, 'on-mutation')).toBe('ask');
    expect(evaluateApprovalStatus(undefined, 'always')).toBe('ask');
  });

  it('mode "never" allows every recognized tier', () => {
    expect(evaluateApprovalStatus('read-only', 'never')).toBe('allow');
    expect(evaluateApprovalStatus('mutating', 'never')).toBe('allow');
    expect(evaluateApprovalStatus('dangerous', 'never')).toBe('allow');
  });

  it('mode "always" asks for every recognized tier', () => {
    expect(evaluateApprovalStatus('read-only', 'always')).toBe('ask');
    expect(evaluateApprovalStatus('mutating', 'always')).toBe('ask');
    expect(evaluateApprovalStatus('dangerous', 'always')).toBe('ask');
  });

  it('mode "on-mutation" allows read-only but asks for mutating and dangerous', () => {
    expect(evaluateApprovalStatus('read-only', 'on-mutation')).toBe('allow');
    expect(evaluateApprovalStatus('mutating', 'on-mutation')).toBe('ask');
    expect(evaluateApprovalStatus('dangerous', 'on-mutation')).toBe('ask');
  });

  it('deny outranks ask which outranks allow for every tier/mode combination', () => {
    for (const tier of TIERS) {
      for (const mode of MODES) {
        const status = evaluateApprovalStatus(tier, mode);
        expect(['allow', 'ask', 'deny']).toContain(status);
        if (mode === 'deny') {
          expect(status).toBe('deny');
        }
      }
    }
  });
});

describe('combineApprovalStatuses', () => {
  it('returns allow when every input is allow', () => {
    expect(combineApprovalStatuses('allow', 'allow')).toBe('allow');
  });

  it('deny beats ask and allow', () => {
    expect(combineApprovalStatuses('allow', 'ask', 'deny')).toBe('deny');
    expect(combineApprovalStatuses('deny', 'allow')).toBe('deny');
  });

  it('ask beats allow but loses to deny', () => {
    expect(combineApprovalStatuses('allow', 'ask')).toBe('ask');
    expect(combineApprovalStatuses('ask', 'deny')).toBe('deny');
  });

  it('returns allow for an empty input list', () => {
    expect(combineApprovalStatuses()).toBe('allow');
  });
});

describe('evaluateCapabilityApproval', () => {
  it('combines tier resolution, mode resolution, and status evaluation', () => {
    const result = evaluateCapabilityApproval(
      { metadata: { dangerous: true } },
      { mode: 'on-mutation' },
    );
    expect(result).toEqual({ tier: 'dangerous', mode: 'on-mutation', status: 'ask' });
  });

  it('applies a per-tier override over the fallback mode', () => {
    const result = evaluateCapabilityApproval(
      { metadata: { dangerous: true } },
      { mode: 'never', tierModes: { dangerous: 'deny' } },
    );
    expect(result).toEqual({ tier: 'dangerous', mode: 'deny', status: 'deny' });
  });
});

describe('resolveApprovalMode', () => {
  it('uses the tier override when present', () => {
    expect(
      resolveApprovalMode('dangerous', { mode: 'never', tierModes: { dangerous: 'always' } }),
    ).toBe('always');
  });

  it('falls back to the configuration mode when there is no override', () => {
    expect(resolveApprovalMode('read-only', { mode: 'always' })).toBe('always');
  });

  it('falls back to the configuration mode for an unrecognized tier', () => {
    expect(resolveApprovalMode(undefined, { mode: 'on-mutation' })).toBe('on-mutation');
  });
});

describe('approvalStatusToDecision', () => {
  it('produces an allow decision', () => {
    expect(
      approvalStatusToDecision('my-tool', { tier: 'read-only', mode: 'never', status: 'allow' }),
    ).toEqual({ allow: true, status: 'allow' });
  });

  it('produces a deny decision with a reason naming the tool and tier', () => {
    const decision = approvalStatusToDecision('my-tool', {
      tier: 'dangerous',
      mode: 'deny',
      status: 'deny',
    });
    expect(decision.allow).toBe(false);
    expect(decision.status).toBe('deny');
    expect(decision.reason).toContain('my-tool');
    expect(decision.reason).toContain('dangerous');
  });

  it('produces a needs_approval decision for ask, labeling unrecognized tiers', () => {
    const decision = approvalStatusToDecision('my-tool', {
      tier: undefined,
      mode: 'never',
      status: 'ask',
    });
    expect(decision.allow).toBe(false);
    expect(decision.status).toBe('needs_approval');
    expect(decision.reason).toContain('unrecognized');
  });
});

describe('createApprovalPolicyHooks', () => {
  it('returns a beforeExecute hook implementing the two-axis model', async () => {
    const hooks = createApprovalPolicyHooks({ mode: 'on-mutation' });
    const readOnlyDecision = await hooks.beforeExecute?.(buildContext({ readOnly: true }));
    const mutatingDecision = await hooks.beforeExecute?.(buildContext({ mutates: true }));
    expect(readOnlyDecision).toEqual({ allow: true, status: 'allow' });
    expect(mutatingDecision?.allow).toBe(false);
    expect(mutatingDecision?.status).toBe('needs_approval');
  });
});

describe('createToolbox — approvalPolicy composition', () => {
  it('denies a dangerous tool outright under mode "deny" for that tier', async () => {
    const dangerousTool = makeTool('delete-everything', { dangerous: true });
    const toolbox = createToolbox([dangerousTool], {
      approvalPolicy: { mode: 'never', tierModes: { dangerous: 'deny' } },
    });
    const result = await toolbox.execute(createToolCall('delete-everything', {}));
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
  });

  it('routes a mutating tool to needs_approval under mode "on-mutation"', async () => {
    const mutatingTool = makeTool('write-file', { mutates: true });
    const toolbox = createToolbox([mutatingTool], {
      approvalPolicy: { mode: 'on-mutation' },
    });
    const result = await toolbox.execute(createToolCall('write-file', {}));
    expect(result.outcome).toBe('action_required');
    expect(result.pendingApproval).toBeDefined();
  });

  it('allows a read-only tool through under mode "on-mutation"', async () => {
    const readOnlyTool = makeTool('read-file', { readOnly: true });
    const toolbox = createToolbox([readOnlyTool], {
      approvalPolicy: { mode: 'on-mutation' },
    });
    const result = await toolbox.execute(createToolCall('read-file', {}));
    expect(result.outcome).toBe('success');
  });

  it('escalates an unrecognized tool to needs_approval even under mode "never"', async () => {
    const unknownTool = makeTool('mystery-tool', {});
    const toolbox = createToolbox([unknownTool], {
      approvalPolicy: { mode: 'never' },
    });
    const result = await toolbox.execute(createToolCall('mystery-tool', {}));
    expect(result.outcome).toBe('action_required');
  });

  it('runs the approval policy before any tool-level policy hook, so a tool cannot grant what its own tier denies', async () => {
    // A dangerous tool whose OWN policy hook tries to allow itself — this
    // simulates a persona/skill layering an allow on top. The capability-tier
    // deny must win: the tool-level hook is never even reached.
    let toolLevelHookCalled = false;
    const dangerousTool = createTool({
      name: 'self-granting-dangerous-tool',
      description: 'A dangerous tool that tries to grant itself execution',
      input: z.object({}),
      metadata: { dangerous: true },
      policy: {
        beforeExecute: () => {
          toolLevelHookCalled = true;
          return { allow: true, status: 'allow' };
        },
      },
      execute: async () => ({ ok: true }),
    });
    const toolbox = createToolbox([dangerousTool], {
      approvalPolicy: { mode: 'never', tierModes: { dangerous: 'deny' } },
    });
    const result = await toolbox.execute(createToolCall('self-granting-dangerous-tool', {}));
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(toolLevelHookCalled).toBe(false);
  });

  it('composes the most restrictive of approvalPolicy and the legacy allowDangerous=false gate', async () => {
    const dangerousTool = makeTool('legacy-dangerous', { dangerous: true });
    const toolbox = createToolbox([dangerousTool], {
      allowDangerous: false,
      approvalPolicy: { mode: 'never' },
    });
    const result = await toolbox.execute(createToolCall('legacy-dangerous', {}));
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
  });

  it('a registry-level deny still wins even when the capability policy already asked (regression: an "ask" must not skip downstream deny checks)', async () => {
    // A mutating tool under `on-mutation` asks first. If the beforeExecute
    // chain short-circuited on that `ask` — returning before the registry
    // hook ever ran — this registry-level deny would never be evaluated,
    // and an approved capability "ask" would silently bypass it (this is
    // exactly what a human approving the capability ask on resume would
    // otherwise slip past).
    let registryHookCalled = false;
    const mutatingTool = makeTool('write-file', { mutates: true });
    const toolbox = createToolbox([mutatingTool], {
      approvalPolicy: { mode: 'on-mutation' },
      policy: {
        beforeExecute: () => {
          registryHookCalled = true;
          return { allow: false, status: 'deny', reason: 'registry says no' };
        },
      },
    });
    const result = await toolbox.execute(createToolCall('write-file', {}));
    expect(registryHookCalled).toBe(true);
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.errorMessage).toContain('registry says no');
  });

  it('returns the capability-tier ask only once registry and tool hooks have both allowed', async () => {
    let registryHookCalled = false;
    let toolHookCalled = false;
    const mutatingTool = createTool({
      name: 'write-file-2',
      description: 'Writes a file',
      input: z.object({}),
      metadata: { mutates: true },
      policy: {
        beforeExecute: () => {
          toolHookCalled = true;
          return { allow: true, status: 'allow' };
        },
      },
      execute: async () => ({ ok: true }),
    });
    const toolbox = createToolbox([mutatingTool], {
      approvalPolicy: { mode: 'on-mutation' },
      policy: {
        beforeExecute: () => {
          registryHookCalled = true;
          return { allow: true, status: 'allow' };
        },
      },
    });
    const result = await toolbox.execute(createToolCall('write-file-2', {}));
    expect(registryHookCalled).toBe(true);
    expect(toolHookCalled).toBe(true);
    expect(result.outcome).toBe('action_required');
    expect(result.pendingApproval).toBeDefined();
  });
});

describe('capability axis fed by real AB-90 and AB-72 metadata, unmodified', () => {
  it('the AB-90 coding toolbox’s read-only tools resolve to the read-only tier', () => {
    const { readFile, grep, glob } = createCodingTools({ root: import.meta.dir });
    for (const tool of [readFile, grep, glob]) {
      expect(evaluateCapabilityApproval(tool, { mode: 'on-mutation' })).toMatchObject({
        tier: 'read-only',
        status: 'allow',
      });
    }
  });

  it('AB-72 OpenAPI verb-derived metadata drives the same capability tiers with no adaptation', async () => {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      servers: [{ url: 'https://example.test' }],
      paths: {
        '/widgets': {
          get: { operationId: 'listWidgets' },
        },
        '/widgets/{id}': {
          delete: {
            operationId: 'deleteWidget',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
        },
      },
    };
    const tools = createToolboxFromOpenAPI(spec);
    const listWidgets = tools.find((tool) => tool.name === 'list-widgets');
    const deleteWidget = tools.find((tool) => tool.name === 'delete-widget');

    expect(evaluateCapabilityApproval(listWidgets!, { mode: 'on-mutation' })).toMatchObject({
      tier: 'read-only',
      status: 'allow',
    });
    expect(evaluateCapabilityApproval(deleteWidget!, { mode: 'never' })).toMatchObject({
      tier: 'dangerous',
      status: 'allow',
    });

    // And under a policy that denies the dangerous tier, the DELETE-derived
    // tool is blocked at execution time — no changes needed to the OpenAPI
    // integration to make this hold.
    const toolbox = createToolbox([deleteWidget!], {
      approvalPolicy: { mode: 'never', tierModes: { dangerous: 'deny' } },
    });
    const result = await toolbox.execute(createToolCall('delete-widget', { id: '1' }));
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
  });
});

// ---------------------------------------------------------------------------
// AB-94 — headless deny-by-default permission mode
// ---------------------------------------------------------------------------

describe('evaluateHeadlessPermission', () => {
  it('denies a tool that is not on the allowlist', () => {
    const result = evaluateHeadlessPermission(
      { toolName: 'shell', params: {} },
      { allowList: ['read_file'] },
    );
    expect(result.status).toBe('deny');
    expect(result.reason).toContain('shell');
    expect(result.reason).toContain('allowlist');
  });

  it('allows a tool that is on the allowlist with no other restrictions', () => {
    const result = evaluateHeadlessPermission(
      { toolName: 'read_file', params: {} },
      { allowList: ['read_file'] },
    );
    expect(result).toEqual({ status: 'allow' });
  });

  it('deny list wins over an allowlisted tool (deny > ask > allow precedence)', () => {
    const result = evaluateHeadlessPermission(
      { toolName: 'read_file', params: {} },
      { allowList: ['read_file'], denyList: ['read_file'] },
    );
    expect(result.status).toBe('deny');
    expect(result.reason).toContain('deny list');
  });

  it('converts a capability-tier "ask" into "deny" instead of parking (headless approvalMode: never)', () => {
    const result = evaluateHeadlessPermission(
      { toolName: 'write_file', params: {}, metadata: { mutates: true } },
      { allowList: ['write_file'], capability: { mode: 'on-mutation' } },
    );
    expect(result.status).toBe('deny');
    expect(result.reason).toContain('headless');
    expect(result.reason).toContain('write_file');
  });

  it('denies outright when the capability tier itself denies', () => {
    const result = evaluateHeadlessPermission(
      { toolName: 'delete_all', params: {}, metadata: { dangerous: true } },
      {
        allowList: ['delete_all'],
        capability: { mode: 'never', tierModes: { dangerous: 'deny' } },
      },
    );
    expect(result.status).toBe('deny');
    expect(result.reason).toContain('capability-tier policy');
  });

  it('runs the synchronous gate and denies with a redacted reason on a path-traversal input', () => {
    const root = '/workspace/project';
    const jailGate: PermissionGate = (_toolName, input) => {
      const path = (input as { path?: string }).path;
      if (typeof path !== 'string' || isAbsolute(path)) {
        return { allow: true };
      }
      const candidate = normalize(resolvePath(root, path));
      if (candidate === root || candidate.startsWith(root + sep)) {
        return { allow: true };
      }
      const error = new PathTraversalError(`Path "${path}" escapes root "${root}"`, {
        requestedPath: path,
        root,
      });
      return { allow: false, reason: error.message };
    };

    const configuration: HeadlessPermissionPolicyConfiguration = {
      allowList: ['read_file'],
      gate: jailGate,
    };

    const traversalResult = evaluateHeadlessPermission(
      { toolName: 'read_file', params: { path: '../../etc/passwd' } },
      configuration,
    );
    expect(traversalResult.status).toBe('deny');
    expect(traversalResult.reason).toContain('escapes root');

    const withinRootResult = evaluateHeadlessPermission(
      { toolName: 'read_file', params: { path: 'src/index.ts' } },
      configuration,
    );
    expect(withinRootResult).toEqual({ status: 'allow' });
  });

  it('redacts an oversized gate denial reason to a bounded length', () => {
    const hugeReason = 'x'.repeat(1000);
    const gate: PermissionGate = () => ({ allow: false, reason: hugeReason });
    const result = evaluateHeadlessPermission(
      { toolName: 'read_file', params: {} },
      { allowList: ['read_file'], gate },
    );
    expect(result.status).toBe('deny');
    expect(result.reason?.length).toBeLessThan(hugeReason.length);
  });
});

describe('createHeadlessPermissionPolicyHooks — toolbox integration', () => {
  it('denies an unlisted tool call and returns a tool-error result, not an exception', async () => {
    const shellTool = makeTool('shell', {});
    const toolbox = createToolbox([shellTool], {
      policy: createHeadlessPermissionPolicyHooks({ allowList: ['read_file'] }),
    });
    const result = await toolbox.execute(createToolCall('shell', {}));
    expect(result.outcome).toBe('error');
    expect(result.error?.code).toBe('POLICY_DENIED');
    expect(result.errorMessage).toContain('shell');
  });

  it('never returns action_required — an ask-tier tool is denied, not parked, under the headless preset', async () => {
    const mutatingTool = makeTool('write-file', { mutates: true });
    const toolbox = createToolbox([mutatingTool], {
      policy: createHeadlessPermissionPolicyHooks({
        allowList: ['write-file'],
        capability: { mode: 'on-mutation' },
      }),
    });
    const result = await toolbox.execute(createToolCall('write-file', {}));
    expect(result.outcome).toBe('error');
    expect(result.pendingApproval).toBeUndefined();
  });

  it('NEUTER: without the headless ask->deny resolution, the same tool would park as needs_approval instead of denying', async () => {
    // This mirrors what createHeadlessPermissionPolicyHooks would do if the
    // ask->deny conversion were removed — using the tier-only approvalPolicy
    // (which does NOT have headless resolution) as the "neutered" stand-in.
    // Confirms the headless preset is doing real work, not just re-expressing
    // pre-existing armorer deny behavior.
    const mutatingTool = makeTool('write-file-neutered', { mutates: true });
    const toolbox = createToolbox([mutatingTool], {
      approvalPolicy: { mode: 'on-mutation' },
    });
    const result = await toolbox.execute(createToolCall('write-file-neutered', {}));
    expect(result.outcome).toBe('action_required');
    expect(result.pendingApproval).toBeDefined();
  });

  it('allows a call through unchanged when it passes the name list, capability tier, and gate', async () => {
    const readTool = makeTool('read-file', { readOnly: true });
    const toolbox = createToolbox([readTool], {
      policy: createHeadlessPermissionPolicyHooks({
        allowList: ['read-file'],
        capability: { mode: 'on-mutation' },
        gate: () => ({ allow: true }),
      }),
    });
    const result = await toolbox.execute(createToolCall('read-file', {}));
    expect(result.outcome).toBe('success');
  });
});
