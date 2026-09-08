import type { GenerateFunction, Toolbox } from '@lostgradient/operative';
import { stopWhen } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createBureau } from 'bureau';
import { z } from 'zod';

import { createTestGateway, requestJSON, waitForCondition, waitForRunState } from '../test';

function createMockGenerate(): GenerateFunction {
  return async () => ({ content: 'Done.', toolCalls: [] });
}

/** A toolbox with no `approvalSecret`/`grantStateStore` configured at all. */
function createEmptyToolbox(): Toolbox {
  return createToolbox([]) as unknown as Toolbox;
}

/**
 * A toolbox with `approvalSecret` configured (required for `issueGrant` to
 * mint a signed grant) and a `charge-card` tool gated behind a `needs_approval`
 * `beforeExecute` policy, matching `reviews.test.ts`'s own fixture.
 */
function createNeedsApprovalToolbox(approvalSecret: string, charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret,
      policy: {
        beforeExecute() {
          return {
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

// A fixed far-future epoch-ms timestamp — never `Date.now()` (deterministic
// test directories forbid real runtime clock calls).
const FAR_FUTURE_EXPIRY = new Date('2099-01-01T00:00:00.000Z').getTime();

function validGrantBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: 'bureau',
    ownerId: 'bureau',
    agentId: '*',
    toolName: 'charge-card',
    scope: 'principal',
    expiresAt: FAR_FUTURE_EXPIRY,
    maxUses: 5,
    delegationBehavior: 'does-not-propagate',
    ...overrides,
  };
}

describe('grants routes', () => {
  it('POST /api/v1/grants issues a signed grant attributed to the caller', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret', []),
      authToken: 'grant-admin-token',
    });
    const authorization = { authorization: 'Bearer grant-admin-token' };

    const response = await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify(validGrantBody()),
    });
    expect(response.status).toBe(201);
    const grant = (await response.json()) as { id: string; principalId: string; signature: string };
    expect(grant.principalId).toBe('static-token');
    expect(grant.id).toStartWith('grant:');
    expect(grant.signature.length).toBeGreaterThan(0);
  });

  it('POST /api/v1/grants ignores a client-supplied principalId in the body', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-2', []),
      authToken: 'grant-admin-token-2',
    });
    const authorization = { authorization: 'Bearer grant-admin-token-2' };

    const response = await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify(validGrantBody({ principalId: 'someone-else' })),
    });
    expect(response.status).toBe(201);
    const grant = (await response.json()) as { principalId: string };
    expect(grant.principalId).toBe('static-token');
  });

  it("POST /api/v1/grants ignores a client-supplied policyRevision, always signing against the toolbox's current revision", async () => {
    // Regression test (review finding, this pull request): `issueGrantBodySchema`
    // has no `policyRevision` field at all, so a client cannot pre-sign a
    // grant for a predictable future policy revision that is dormant today
    // but becomes valid once that revision deploys — the same class of
    // trust-boundary bug as accepting a client-supplied `principalId` above.
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-policy-revision', []),
    });

    const response = await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      // `policyRevision` is not part of `issueGrantBodySchema`; a request
      // body carrying one exercises the schema's `.strict()`-free but
      // additive-only shape — the field is simply dropped, never forwarded.
      body: JSON.stringify(validGrantBody({ policyRevision: 'policy:99-from-the-future' })),
    });
    expect(response.status).toBe(201);
    const grant = (await response.json()) as { policyRevision: string };
    expect(grant.policyRevision).toBe('policy:1');
    expect(grant.policyRevision).not.toBe('policy:99-from-the-future');
  });

  it('POST /api/v1/grants returns 400 for a non-positive-integer maxUses', async () => {
    // Regression test (review finding, this pull request): a fractional or
    // non-positive `maxUses` breaks usage-counting semantics downstream
    // (`Toolbox.issueGrant` initializes `usesRemaining` to `maxUses`
    // verbatim; matching only requires `usesRemaining > 0` after
    // decrementing by exactly 1 per use).
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-max-uses', []),
    });

    for (const maxUses of [1.5, 0, -1]) {
      const response = await requestJSON(gateway, '/api/v1/grants', {
        method: 'POST',
        body: JSON.stringify(validGrantBody({ maxUses })),
      });
      expect(response.status).toBe(400);
    }
  });

  it('POST /api/v1/grants returns 400 for a body missing required fields', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-3', []),
    });

    const response = await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      body: JSON.stringify({ toolName: 'charge-card' }),
    });
    expect(response.status).toBe(400);
  });

  it('POST /api/v1/grants returns 400 (not 500) for a completely empty request body', async () => {
    // Regression test: `parseReviewBody` treats an empty body as `{}`, which
    // parses fine against the review routes' all-optional schemas but must
    // still fail `issueGrantBodySchema`'s required fields through the same
    // `safeParse` → 400 path, not an uncaught `ZodError` from `schema.parse`.
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-empty-body', []),
    });

    const response = await requestJSON(gateway, '/api/v1/grants', { method: 'POST' });
    expect(response.status).toBe(400);
  });

  it('POST /api/v1/grants maps a toolbox with no approvalSecret configured to a 500', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const response = await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      body: JSON.stringify(validGrantBody()),
    });
    expect(response.status).toBe(500);
  });

  it('GET /api/v1/grants maps a toolbox with no grant state store configured to a 500', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createEmptyToolbox(),
    });

    const response = await requestJSON(gateway, '/api/v1/grants');
    expect(response.status).toBe(500);
  });

  it('POST /api/v1/grants returns 400 for a malformed JSON body', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-4', []),
    });

    const response = await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      body: '{not valid json',
    });
    expect(response.status).toBe(400);
  });

  it('DELETE /api/v1/grants/:id revokes a grant and GET reports it revoked', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-5', []),
    });

    const issueResponse = await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      body: JSON.stringify(validGrantBody()),
    });
    const { id } = (await issueResponse.json()) as { id: string };

    const deleteResponse = await requestJSON(gateway, `/api/v1/grants/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    expect(deleteResponse.status).toBe(204);

    const listResponse = await requestJSON(gateway, '/api/v1/grants');
    const grants = (await listResponse.json()) as Array<{ id: string; revoked: boolean }>;
    const revoked = grants.find((grant) => grant.id === id);
    expect(revoked?.revoked).toBe(true);
  });

  it('DELETE /api/v1/grants/:id returns 404 for an unknown grant id', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-6', []),
    });

    const response = await requestJSON(gateway, '/api/v1/grants/nope', { method: 'DELETE' });
    expect(response.status).toBe(404);
  });

  it('DELETE /api/v1/grants/:id returns 404 for a grant issued to a different principal', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-6b', []),
    });

    // Seeded directly against the Bureau method, bypassing the route (whose
    // POST always overrides `principalId` with the caller) — the only way to
    // get a grant on record for a principal other than the test's own caller.
    const othersGrant = await gateway.bureau.issueGrant({
      ...validGrantBody(),
      principalId: 'someone-else',
    } as Parameters<typeof gateway.bureau.issueGrant>[0]);

    const response = await requestJSON(
      gateway,
      `/api/v1/grants/${encodeURIComponent(othersGrant.id)}`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(404);

    // Never actually revoked — the caller's lack of visibility isn't a
    // side-effecting no-op on someone else's grant.
    const stillThere = await gateway.bureau.listGrants({ principalId: 'someone-else' });
    expect(stillThere.find((grant) => grant.id === othersGrant.id)?.revoked).toBe(false);
  });

  it("GET /api/v1/grants scopes the listing to the authenticated principal, excluding another principal's grants", async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-7', []),
      authToken: 'grant-caller-token',
    });

    // Seeded directly against the Bureau method for a DIFFERENT principal —
    // the rollback-relevant case (AB-347's rollback trigger: "a grant route
    // leaks another principal's grants through GET /grants").
    await gateway.bureau.issueGrant({
      ...validGrantBody(),
      principalId: 'someone-else',
    } as Parameters<typeof gateway.bureau.issueGrant>[0]);

    // Issue a grant as the static-token principal (the only principal this
    // gateway's authentication middleware can produce without a managed key
    // store) and confirm the listing returns exactly that principal's own
    // grants — the filter this route always applies via `resolvePrincipal`.
    await requestJSON(gateway, '/api/v1/grants', {
      method: 'POST',
      headers: { authorization: 'Bearer grant-caller-token' },
      body: JSON.stringify(validGrantBody()),
    });

    const listResponse = await requestJSON(gateway, '/api/v1/grants', {
      headers: { authorization: 'Bearer grant-caller-token' },
    });
    expect(listResponse.status).toBe(200);
    const grants = (await listResponse.json()) as Array<{ principalId: string }>;
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((grant) => grant.principalId === 'static-token')).toBe(true);
  });

  it('GET /api/v1/grants returns an empty array when nothing has been issued', async () => {
    const gateway = await createTestGateway({
      generate: createMockGenerate(),
      toolbox: createNeedsApprovalToolbox('grant-test-secret-8', []),
    });

    const response = await requestJSON(gateway, '/api/v1/grants');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });
});

// ── AB-346 follow-up: `combineToolboxes` and durable opt-in tools ────────
//
// AB-346's checkpoint comment (2026-09-04) flagged that `combineToolboxes`
// (used by `wireDurableOptInTools` to graft the `requestHumanInput`/
// `scheduleWakeup` tools onto a run's toolbox) rebuilds a fresh toolbox via
// `createToolbox(configurations, { context })`, forwarding only `context` —
// see `combine-toolboxes.ts`. This test drives a real durable run
// (`humanInput: true`) that also carries a `needs_approval` tool, and
// records what actually happens against the gateway route surface this
// issue owns, per the coordinator's instruction to report rather than
// widen scope. It deliberately issues NO grant at all (a review finding on
// this pull request: an earlier version of this test issued a matching
// grant, which would silently stop detecting the `policy`-dropping
// regression — and start passing for the WRONG reason — the moment AB-362
// restores grant-matching without also restoring the policy hook itself).
//
// FINDING (reported on AB-347, not fixed here — this is `combineToolboxes`'/
// `wireDurableOptInTools`'s own gap in `packages/armorer`/`packages/bureau`,
// out of this gateway-only issue's scope): the gap is broader than AB-346's
// checkpoint anticipated. `combineToolboxes` forwards neither `approvalSecret`
// nor `grantStateStore` NOR the toolbox's `policy` (the `beforeExecute`
// `needs_approval` hook itself) into the combined toolbox it builds. The
// result is not "the grant fails to match and the ordinary ask pipeline
// runs" (grants degrading safely to their documented absent-is-safe
// behavior) — it is that EVERY tool call on a run that opts into durable
// `humanInput`/`wakeup` tools skips capability-approval and grant-matching
// alike, unconditionally, whether or not a grant exists. Confirmed in
// isolation with no grant issued at all: the same `needs_approval` tool
// still executes immediately. This is a live security-relevant regression,
// not a grant-matching edge case, and is tracked as AB-362 against
// `packages/armorer/src/combine-toolboxes.ts` /
// `packages/bureau/src/runtime-composition.ts`'s `wireDurableOptInTools`.
// This test is intentionally pending on AB-362: it locks in and documents
// the current (broken) behavior so the suite breaks loudly, forcing an
// update, once AB-362 lands a fix.
describe('grants routes — durable opt-in tools (AB-346 follow-up, gap tracked as AB-362)', () => {
  it('documents that a run opting into durable tools skips its needs_approval policy entirely, independent of any grant (pending AB-362)', async () => {
    const charges: number[] = [];
    const generate: GenerateFunction = async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [{ id: 'call-durable-1', name: 'charge-card', arguments: { cents: 4200 } }],
          }
        : { content: 'ok', toolCalls: [] };

    const bureau = await createBureau({
      agents: {},
      generate,
      toolbox: createNeedsApprovalToolbox('durable-grant-secret', charges),
      stopWhen: stopWhen.toolOutcome('action_required'),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
    });
    const gateway = await createTestGateway(bureau, { authToken: 'durable-grant-token' });
    const authorization = { authorization: 'Bearer durable-grant-token' };

    // No grant is issued here — see the module comment above the
    // `describe` block for why proving the tool still executes with NO
    // grant at all is the stronger, regression-resistant assertion.
    const createResponse = await requestJSON(gateway, '/api/v1/runs', {
      method: 'POST',
      headers: authorization,
      body: JSON.stringify({ message: 'Charge the customer' }),
    });
    const createdRun = await createResponse.json();
    await waitForRunState(gateway.bureau, createdRun.id);

    await waitForCondition(
      () => charges.length > 0 || gateway.bureau.listPendingReviews().length > 0,
      'expected either the tool call to execute or a pending review to appear',
    );

    // See the FINDING above the `describe` block: the tool executes
    // immediately (no review is ever created) with NO grant issued —
    // `combineToolboxes` drops the toolbox's `policy` (the
    // `needs_approval` hook) entirely for this run, independent of grants.
    expect(charges).toEqual([4200]);
    expect(gateway.bureau.listPendingReviews()).toHaveLength(0);
  });
});
