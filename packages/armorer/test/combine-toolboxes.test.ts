import { describe, expect, expectTypeOf, it } from 'bun:test';
import { z } from 'zod';

import {
  combineToolboxes,
  createProcessLocalApprovalStateStore,
  createProcessLocalGrantStateStore,
  createTool,
  createToolbox,
  GRANT_VERSION,
  type ReusableApprovalGrant,
  type SignedPendingToolApproval,
  signGrant,
  ToolboxGrantUsedEvent,
} from '../src';

const approvalRequestContext = {
  authority: {
    principalId: 'principal-combine',
    tenantId: 'tenant-combine',
    ownerId: 'owner-combine',
    capabilities: ['tools:execute'],
    authorizationRevision: 'authorization:1',
  },
  audience: 'tenant' as const,
  agentId: 'agent-combine',
  runId: 'run-combine',
};

const approvalExecutionOptions = { requestContext: approvalRequestContext };

describe('combineToolboxes', () => {
  it('throws when no toolboxes are provided', () => {
    const combine = combineToolboxes as unknown as () => ReturnType<typeof createToolbox>;
    expect(() => combine()).toThrow('combineToolboxes() requires at least 1 Toolbox');
  });

  it('combines tools from multiple toolboxes', async () => {
    const a = createToolbox([
      createTool({
        name: 'tool-a',
        description: 'tool a',
        input: z.object({}),
        execute: async () => 'A',
      }),
    ]);

    const b = createToolbox([
      createTool({
        name: 'tool-b',
        description: 'tool b',
        input: z.object({}),
        execute: async () => 'B',
      }),
    ]);

    const combined = combineToolboxes(a, b);

    const resA = await combined.execute({ id: 'a-1', name: 'tool-a', arguments: {} });
    const resB = await combined.execute({ id: 'b-1', name: 'tool-b', arguments: {} });

    expect(resA.result).toBe('A');
    expect(resB.result).toBe('B');
  });

  it('prefers later toolboxes on name collisions', async () => {
    const first = createToolbox([
      createTool({
        name: 'echo',
        description: 'echo',
        input: z.object({ value: z.string() }),
        execute: async ({ value }) => `first:${value}`,
      }),
    ]);

    const second = createToolbox([
      createTool({
        name: 'echo',
        description: 'echo',
        input: z.object({ value: z.string() }),
        execute: async ({ value }) => `second:${value}`,
      }),
    ]);

    const combined = combineToolboxes(first, second);
    const res = await combined.execute({
      id: 'echo-1',
      name: 'echo',
      arguments: { value: 'hi' },
    });

    expect(res.result).toBe('second:hi');
  });

  it('merges contexts from all toolboxes (last wins)', async () => {
    const a = createToolbox(
      [
        createTool({
          name: 'ctx',
          description: 'ctx',
          input: z.object({}),
          execute: async (_params, context) => {
            const ctx = context as unknown as Record<string, unknown>;
            return {
              workspaceId: ctx.workspaceId,
              role: ctx.role,
              shared: ctx.shared,
            };
          },
        }),
      ],
      {
        context: { workspaceId: 'ws-1', shared: 'a' },
      },
    );

    const b = createToolbox([], {
      context: { role: 'admin', shared: 'b' },
    });

    const combined = combineToolboxes(a, b);
    const res = await combined.execute({ id: 'ctx-1', name: 'ctx', arguments: {} });

    expect(res.result).toEqual({
      workspaceId: 'ws-1',
      role: 'admin',
      shared: 'b',
    });
  });

  it('preserves tool type information', () => {
    const alpha = createTool({
      name: 'alpha',
      description: 'alpha',
      input: z.object({}),
      execute: async () => 'alpha',
    });
    const beta = createTool({
      name: 'beta',
      description: 'beta',
      input: z.object({}),
      execute: async () => 'beta',
    });

    const a = createToolbox([alpha] as const);
    const b = createToolbox([beta] as const);
    const combined = combineToolboxes(a, b);

    expectTypeOf<ReturnType<typeof combined.tools>[number]['name']>().toEqualTypeOf<
      'alpha' | 'beta'
    >();
  });

  it("keeps the first toolbox's needs_approval policy in effect for the combined toolbox (AB-362)", async () => {
    let executions = 0;
    const gated = createToolbox(
      [
        createTool({
          name: 'gated',
          description: 'requires approval',
          version: '1.0.0',
          input: z.object({}),
          async execute() {
            executions += 1;
            return 'executed';
          },
        }),
      ],
      {
        approvalSecret: 'combine-toolboxes-secret',
        policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
      },
    );
    const other = createToolbox([
      createTool({
        name: 'other',
        description: 'other',
        input: z.object({}),
        execute: async () => 'other',
      }),
    ]);

    const combined = combineToolboxes(gated, other);

    const paused = await combined.execute(
      { id: 'gated-1', name: 'gated', arguments: {} },
      approvalExecutionOptions,
    );

    expect(paused.outcome).toBe('action_required');
    expect(paused.pendingApproval).toBeDefined();
    expect(executions).toBe(0);

    const resumed = await combined.resumeApproval(
      paused.pendingApproval as SignedPendingToolApproval,
      approvalExecutionOptions,
    );

    expect(resumed.outcome).toBe('success');
    expect(resumed.result).toBe('executed');
    expect(executions).toBe(1);
  });

  it("forwards the first toolbox's registry-level policyContext alongside its policy (AB-362 review finding)", async () => {
    let observedTenantId: unknown;
    const gated = createToolbox(
      [
        createTool({
          name: 'gated',
          description: 'requires approval unless the registry context says otherwise',
          version: '1.0.0',
          input: z.object({}),
          execute: async () => 'executed',
        }),
      ],
      {
        approvalSecret: 'combine-toolboxes-policy-context-secret',
        policyContext: { tenantId: 'tenant-combine-policy-context' },
        policy: {
          beforeExecute(context) {
            observedTenantId = context.policyContext?.['tenantId'];
            return context.policyContext?.['tenantId'] === 'tenant-combine-policy-context'
              ? { status: 'needs_approval' as const }
              : { allow: true };
          },
        },
      },
    );
    const other = createToolbox([
      createTool({
        name: 'other',
        description: 'other',
        input: z.object({}),
        execute: async () => 'other',
      }),
    ]);

    const combined = combineToolboxes(gated, other);

    const paused = await combined.execute(
      { id: 'gated-policy-context-1', name: 'gated', arguments: {} },
      approvalExecutionOptions,
    );

    // Without policyContext forwarding, `tenantId` is undefined on the
    // combined toolbox's registry-level context, `beforeExecute` falls
    // through to `{ allow: true }`, and the tool executes immediately
    // instead of pausing for approval.
    expect(observedTenantId).toBe('tenant-combine-policy-context');
    expect(paused.outcome).toBe('action_required');
    expect(paused.pendingApproval).toBeDefined();
  });

  it("keeps the first toolbox's approvalStateStore and grantStateStore in effect so a matching reusable grant short-circuits approval (AB-362)", async () => {
    const grantSecret = 'combine-toolboxes-grant-secret';
    const approvalStateStore = createProcessLocalApprovalStateStore();
    const grantStateStore = createProcessLocalGrantStateStore();

    const grantRequestContext = {
      authority: {
        principalId: 'principal-grant-combine',
        tenantId: 'tenant-grant-combine',
        ownerId: 'owner-grant-combine',
        capabilities: ['tools:execute'],
        authorizationRevision: 'authorization:1',
      },
      audience: 'tenant' as const,
      agentId: 'agent-grant-combine',
      runId: 'run-grant-combine',
    };

    // A fixed epoch-ms timestamp in the past and a far-future expiry —
    // never `Date.now()` (deterministic test directories forbid real
    // runtime clock calls); the toolbox checks `expiresAt` against its own
    // real clock since no `approvalNow` is injected here.
    const issuedAt = new Date('2026-01-01T00:00:00.000Z').getTime();
    const farFutureExpiry = new Date('2099-01-01T00:00:00.000Z').getTime();
    const unsignedGrant: ReusableApprovalGrant = {
      version: GRANT_VERSION,
      id: 'grant:combine-toolboxes-1',
      principalId: grantRequestContext.authority.principalId,
      tenantId: grantRequestContext.authority.tenantId,
      ownerId: grantRequestContext.authority.ownerId,
      agentId: grantRequestContext.agentId,
      toolName: 'read-file',
      scope: 'session',
      issuedAt,
      expiresAt: farFutureExpiry,
      maxUses: 1,
      usesRemaining: 1,
      policyRevision: 'policy:1',
      revoked: false,
      delegationBehavior: 'does-not-propagate',
      signature: '',
    };
    const grant = { ...unsignedGrant, signature: signGrant(unsignedGrant, grantSecret) };
    await grantStateStore.issue(grant);

    let executions = 0;
    const base = createToolbox(
      [
        createTool({
          name: 'read-file',
          description: 'reads a file',
          version: '1.0.0',
          input: z.object({}),
          async execute() {
            executions += 1;
            return 'file contents';
          },
        }),
      ],
      {
        approvalSecret: grantSecret,
        approvalStateStore,
        approvalPolicy: { mode: 'always' },
        grantStateStore,
      },
    );
    const other = createToolbox([
      createTool({
        name: 'other',
        description: 'other',
        input: z.object({}),
        execute: async () => 'other',
      }),
    ]);

    const combined = combineToolboxes(base, other);

    const grantUsedEvents: ToolboxGrantUsedEvent[] = [];
    combined.addEventListener('grant.used', (event) => {
      grantUsedEvents.push(event);
    });

    const result = await combined.execute(
      { id: 'read-file-1', name: 'read-file', arguments: {} },
      { requestContext: grantRequestContext },
    );

    expect(result.outcome).toBe('success');
    expect(result.result).toBe('file contents');
    expect(executions).toBe(1);
    expect(grantUsedEvents).toHaveLength(1);
    const storedGrant = await grantStateStore.get(grant.id);
    expect(storedGrant?.usesRemaining).toBe(0);
  });

  it("does not expose the first toolbox's approvalSecret on the combined toolbox's public surface (AB-362 review finding)", async () => {
    const gated = createToolbox([], {
      approvalSecret: 'combine-toolboxes-secret-not-public',
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    });
    const other = createToolbox([
      createTool({
        name: 'other',
        description: 'other',
        input: z.object({}),
        execute: async () => 'other',
      }),
    ]);

    const combined = combineToolboxes(gated, other);

    // Forwarding the first toolbox's approval configuration must not mean
    // handing any caller holding `combined` a way to read the secret back
    // off it — the approval policy still applies (proven by the previous
    // test), but the secret itself stays out of the public object. This
    // covers every reflection surface a caller could use, not just
    // `Object.keys()`: a non-enumerable symbol-keyed property is still
    // discoverable via `Object.getOwnPropertySymbols()` (an earlier
    // version of this fix relied on exactly that and was correctly
    // flagged in review), so this also asserts there are no OWN symbol
    // properties on the object at all.
    expect(Object.keys(combined)).not.toContain('getOptions');
    expect(Object.keys(combined)).not.toContain('approvalSecret');
    expect(Object.getOwnPropertyNames(combined)).not.toContain('approvalSecret');
    expect(Object.getOwnPropertySymbols(combined)).toEqual([]);
    expect(JSON.stringify(combined)).not.toContain('combine-toolboxes-secret-not-public');
  });

  it("still forwards approval gating when the first toolbox is wrapped in a transparent Proxy (AB-362 review finding, matches Bureau's withDefaultToolboxRequestContext)", async () => {
    const gated = createToolbox(
      [
        createTool({
          name: 'gated',
          description: 'requires approval',
          version: '1.0.0',
          input: z.object({}),
          execute: async () => 'executed',
        }),
      ],
      {
        approvalSecret: 'combine-toolboxes-proxy-secret',
        policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
      },
    );
    // The exact wrapping shape `packages/bureau/src/runtime-composition.ts`'s
    // `withDefaultToolboxRequestContext` uses: a pass-through `Proxy` that
    // only special-cases one property and forwards everything else —
    // `execute`, in the real code — via `Reflect.get`.
    const proxied = new Proxy(gated, {
      get(target, property, receiver) {
        if (property === 'tools') return () => target.tools();
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const other = createToolbox([
      createTool({
        name: 'other',
        description: 'other',
        input: z.object({}),
        execute: async () => 'other',
      }),
    ]);

    const combined = combineToolboxes(proxied, other);

    const paused = await combined.execute(
      { id: 'gated-1', name: 'gated', arguments: {} },
      approvalExecutionOptions,
    );

    expect(paused.outcome).toBe('action_required');
  });

  it("does not re-apply the first toolbox's middleware to already-transformed configurations (AB-362 review finding)", async () => {
    let middlewareApplications = 0;
    const base = createToolbox(
      [
        createTool({
          name: 'counted',
          description: 'counted',
          input: z.object({}),
          execute: async () => 'counted',
        }),
      ],
      {
        middleware: [
          (configuration) => {
            middlewareApplications += 1;
            return configuration;
          },
        ],
      },
    );
    expect(middlewareApplications).toBe(1);

    const other = createToolbox([
      createTool({
        name: 'other',
        description: 'other',
        input: z.object({}),
        execute: async () => 'other',
      }),
    ]);

    combineToolboxes(base, other);

    // Combining must not re-run the base toolbox's middleware against the
    // configuration `toJSON()` already returned post-middleware.
    expect(middlewareApplications).toBe(1);
  });

  it("forwards a snapshot of the first toolbox's options taken at construction, not a live re-read of a caller-mutated object (AB-362 review finding)", async () => {
    const mutableOptions: { policy?: { beforeExecute: () => { status: 'needs_approval' } } } = {
      policy: { beforeExecute: () => ({ status: 'needs_approval' as const }) },
    };
    const gated = createToolbox(
      [
        createTool({
          name: 'gated',
          description: 'gated',
          input: z.object({}),
          execute: async () => 'executed',
        }),
      ],
      mutableOptions,
    );

    // A caller mutating the object it originally passed in must not change
    // what a LATER combineToolboxes() call forwards — the toolbox's own
    // approval behavior was already fixed at construction (armorer never
    // re-reads `options.policy` per call either), so the forwarded
    // snapshot must agree with that, not with this later mutation.
    delete mutableOptions.policy;

    const other = createToolbox([
      createTool({
        name: 'other',
        description: 'other',
        input: z.object({}),
        execute: async () => 'other',
      }),
    ]);
    const combined = combineToolboxes(gated, other);

    const result = await combined.execute(
      { id: 'gated-1', name: 'gated', arguments: {} },
      approvalExecutionOptions,
    );
    expect(result.outcome).toBe('action_required');
  });
});
