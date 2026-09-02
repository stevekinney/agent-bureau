/**
 * Compile-only fixture for AB-197 (`ab-67-types`).
 *
 * Constructs one value of each type this issue exports from
 * `packages/operative/src/durable/types.ts`, against the exact field sets
 * AB-67's decision record fixes. Included in `check-types` (the package's
 * `tsconfig.json` `include` covers all of `src`) and excluded from the Bun
 * test runner (the filename does not match `*.test.ts`), mirroring
 * `ab-42-types`'s `session-input-types.check.ts` pattern: an accidental
 * field rename or shape drift fails `check-types` immediately instead of
 * rotting silently in an unexercised type export.
 *
 * This file is never imported by production code or by any `tsdown` entry
 * point (see `tsdown.config.ts`), so it contributes nothing to `dist/` and
 * nothing to coverage.
 */
import type {
  SteeringCommand,
  SteeringCommandFailure,
  SteeringCommandState,
  SteeringDesiredState,
  SteeringEffectiveState,
  SteeringRequestedValue,
  SteeringTargetKind,
} from './types';

export const steeringTargetKinds: readonly SteeringTargetKind[] = [
  'agent-identity',
  'route',
  'model',
  'provider',
  'effort',
  'pause',
  'resume',
];

export const pauseValue: SteeringRequestedValue = { target: 'pause' };
export const resumeValue: SteeringRequestedValue = { target: 'resume' };
export const agentIdentityPolicyValue: SteeringRequestedValue = {
  target: 'agent-identity',
  policyRef: 'default-agent-policy',
};
export const agentIdentityOverrideValue: SteeringRequestedValue = {
  target: 'agent-identity',
  override: 'catalog-agent-name',
};
export const routePolicyValue: SteeringRequestedValue = {
  target: 'route',
  policyRef: 'default-route',
};
export const routeOverrideValue: SteeringRequestedValue = { target: 'route', override: 'primary' };
export const modelPolicyValue: SteeringRequestedValue = {
  target: 'model',
  policyRef: 'default-model',
};
export const modelOverrideValue: SteeringRequestedValue = {
  target: 'model',
  override: 'claude-sonnet',
};
export const providerPolicyValue: SteeringRequestedValue = {
  target: 'provider',
  policyRef: 'default-provider',
};
export const providerOverrideValue: SteeringRequestedValue = {
  target: 'provider',
  override: 'anthropic',
};
export const effortPolicyValue: SteeringRequestedValue = {
  target: 'effort',
  policyRef: 'default-effort',
};
export const effortOverrideValue: SteeringRequestedValue = { target: 'effort', override: 'high' };

export const steeringCommand: SteeringCommand = {
  id: 'steering-command-id',
  idOrigin: 'caller',
  sessionId: 'session-id',
  principal: 'user-123',
  requestedValue: routeOverrideValue,
  expectedRevision: 3,
  requestedAt: new Date(0).toISOString(),
  deadline: new Date(0).toISOString(),
  runId: 'run-id',
};

export const steeringCommandNoOptionals: SteeringCommand = {
  id: 'steering-command-id-2',
  idOrigin: 'generated',
  sessionId: 'session-id',
  principal: 'user-123',
  requestedValue: pauseValue,
  requestedAt: new Date(0).toISOString(),
};

export const steeringCommandFailure: SteeringCommandFailure = {
  failedAt: new Date(0).toISOString(),
  reason: 'session-terminal',
};

export const steeringCommandFailureSuperseded: SteeringCommandFailure = {
  failedAt: new Date(0).toISOString(),
  reason: 'superseded-by',
  supersededBy: 'successor-command-id',
};

export const steeringCommandFailureReasons: readonly SteeringCommandFailure['reason'][] = [
  'session-terminal',
  'run-terminal',
  'run-ambiguous',
  'authorization-revoked',
  'policy-denied',
  'deadline-passed',
  'superseded-by',
];

// AB-67's 2026-09-02 coordinator amendments: `policyRef` and `override` are
// encoded as an exclusive pair. A literal supplying both, or neither, must
// be rejected by the type checker.
export const routeBothValue: SteeringRequestedValue = {
  target: 'route',
  policyRef: 'default-route',
  // @ts-expect-error — a `SteeringRequestedValue` literal must not supply both `policyRef` and `override`.
  override: 'primary',
};
// @ts-expect-error — a `SteeringRequestedValue` literal for a non-pause/resume target must supply `policyRef` or `override`.
export const routeNeitherValue: SteeringRequestedValue = { target: 'route' };

export const steeringCommandStates: readonly SteeringCommandState[] = [
  'requested',
  'accepted',
  'applied',
  'rejected',
  'superseded',
  'failed',
];

export const steeringDesiredState: SteeringDesiredState = {
  agentName: 'triage-agent',
  route: 'primary',
  model: 'claude-sonnet',
  provider: 'anthropic',
  effort: 'high',
  paused: false,
  configVersion: 4,
};

export const steeringDesiredStateMinimal: SteeringDesiredState = {
  paused: true,
  configVersion: 0,
};

export const steeringEffectiveState: SteeringEffectiveState = {
  ...steeringDesiredState,
  appliedAtStep: 2,
  appliedAtRunId: 'run-id',
  appliedAt: new Date(0).toISOString(),
};
